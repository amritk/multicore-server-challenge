// The read plans off the HTTP workers: one process that every worker reaches
// over loopback TCP, which owns the box's read connections and gathers the
// reads of every worker into one queue, so a plan holds the reads of the
// whole box rather than of one worker. A plan's cost is mostly fixed (its
// statements, the tag list, an article read once however many answers hold
// it), so one queue makes plans about as large in half the window that four
// queues need. One queue for the box, owned by a process of its own, is an
// idea from the challenge's zig-iouring-nick-potts submission (its "drain");
// the protocol and this code are written here.
//
// The protocol is framed bytes, both ways (integers big-endian):
//
//   request  id (u32) · kind (u8, `K_`) · viewer (i64) · limit (i64) ·
//            offset (i64) · key length (u16, 0xFFFF for none) · the key
//   reply    id (u32) · status (u16: 200, 404, 500, or PLAN_REPLY_ALONE) ·
//            body length (u32) · the body (the answer's JSON, for 200)
//
// A plan starts once `planMin` reads wait or the oldest has waited
// `planWait`, while a plan is free; the service answers each read of it
// with the JSON its plan rendered. A read the plan could not answer
// (PLAN_REPLY_ALONE) the worker sends alone on its own connection, where it
// answers its own error; 500 is a plan whose connection was lost. Nothing
// outlives its plan: every answer was read while its request waited.
import {
  connectResult,
  netAddress,
  netClose,
  netRead,
  netWrite,
  pollAdd,
  pollCreate,
  pollModify,
  pollRemove,
  pollWait,
  tcpAccept,
  tcpConnect,
} from "nish:net"
import { monotonicNanos } from "nish:process"
import { Secret } from "nish:secret"
import { copyBytes } from "nish/bytes"
import {
  PG_FAILED,
  PG_GROUP_DONE,
  PG_LOST,
  PG_NEED_MORE,
  PG_POOL_FULL,
  PgConfig,
  PgConnection,
  PgPool,
} from "nish/net/postgres"
import { PLAN_ALONE, PLAN_MAX, ReadPlan } from "./plan"
import { registerPlanStatements } from "./sql"

/** A reply's status for a read the plan could not answer: the worker sends it alone. */
export const PLAN_REPLY_ALONE: i32 = 65535
/** A request's key length for none. */
const PLAN_NO_KEY: i32 = 65535
/** A request's bytes before its key, and a reply's before its body. */
export const PLAN_REQUEST_HEAD: i32 = 31
export const PLAN_REPLY_HEAD: i32 = 10
/** The most workers connected at once. */
const PLAN_PEERS: i32 = 64
const PLAN_LISTENER: i32 = -1
/** Tokens of the read connections: -16 down. */
const PLAN_POOL_TOKEN: i32 = -16
const PLAN_AGAIN: i32 = -11
const PLAN_READABLE: i32 = 5
/** The most reads that wait; past it a read is answered 500 at once. */
const PLAN_QUEUE: i32 = 65536
const PLAN_TICKETS: i32 = 131072
const PLAN_STATE_FREE: i32 = 0
const PLAN_STATE_A: i32 = 1
const PLAN_STATE_B: i32 = 2

/** Grows `a` to hold at least `n` bytes, keeping `[0, keep)`. */
const planGrown = (a: u8[], n: i32, keep: i32): u8[] => {
  if (n <= toI32(a.length)) {
    return a
  }
  let size: i32 = toI32(a.length) < 65536 ? 65536 : toI32(a.length)
  while (size < n) {
    size = size * 2
  }
  const out: u8[] = new Array<u8>(size)
  copyBytes(out, 0, a, 0, keep)
  return out
}

const putU16 = (o: u8[], at: i32, v: i32): void => {
  o[at] = toU8((v >> 8) & 255)
  o[at + 1] = toU8(v & 255)
}

const putU32 = (o: u8[], at: i32, v: i32): void => {
  o[at] = toU8((v >> 24) & 255)
  o[at + 1] = toU8((v >> 16) & 255)
  o[at + 2] = toU8((v >> 8) & 255)
  o[at + 3] = toU8(v & 255)
}

const putI64 = (o: u8[], at: i32, v: i64): void => {
  for (let k: i32 = 0; k < 8; k++) {
    o[at + k] = toU8(toI32((v >> toI64(56 - 8 * k)) & toI64(255)))
  }
}

const getU16 = (b: u8[], at: i32): i32 => (toI32(b[at]) << 8) | toI32(b[at + 1])

const getU32 = (b: u8[], at: i32): i32 =>
  (toI32(b[at]) << 24) | (toI32(b[at + 1]) << 16) | (toI32(b[at + 2]) << 8) | toI32(b[at + 3])

const getI64 = (b: u8[], at: i32): i64 => {
  let v: i64 = 0
  for (let k: i32 = 0; k < 8; k++) {
    v = (v << toI64(8)) | toI64(toI32(b[at + k]))
  }
  return v
}

/** One end of a framed byte stream: what was read and not yet taken, and what waits to be written. */
class PlanStream {
  fd: i32 = -1
  input: u8[]
  inputStart: i32 = 0
  inputEnd: i32 = 0
  output: u8[]
  outputStart: i32 = 0
  outputEnd: i32 = 0
  /** The interest last armed in epoll. */
  armed: i32 = 0

  constructor() {
    this.input = new Array<u8>(65536)
    this.output = new Array<u8>(65536)
  }

  /** Makes room for `n` more bytes of output, moving what waits to the front. */
  outputRoom(n: i32): void {
    if (this.outputStart === this.outputEnd) {
      this.outputStart = 0
      this.outputEnd = 0
    }
    if (this.outputEnd + n <= toI32(this.output.length)) {
      return
    }
    const left: i32 = this.outputEnd - this.outputStart
    if (this.outputStart > 0) {
      copyBytes(this.output, 0, this.output, this.outputStart, left)
      this.outputStart = 0
      this.outputEnd = left
    }
    this.output = planGrown(this.output, left + n, left)
  }

  /** Writes what waits until the socket would block; false when it is gone. */
  send(): boolean {
    while (this.outputEnd > this.outputStart) {
      const n: i32 = netWrite(this.fd, this.output, this.outputStart, this.outputEnd - this.outputStart)
      if (n === PLAN_AGAIN) {
        return true
      }
      if (n <= 0) {
        return false
      }
      this.outputStart += n
    }
    this.outputStart = 0
    this.outputEnd = 0
    return true
  }

  /** Reads what the socket holds, growing the input for a frame larger than it; false when it is gone. */
  receive(): boolean {
    while (true) {
      if (this.inputStart > 0) {
        const left: i32 = this.inputEnd - this.inputStart
        copyBytes(this.input, 0, this.input, this.inputStart, left)
        this.inputStart = 0
        this.inputEnd = left
      }
      if (this.inputEnd === toI32(this.input.length)) {
        this.input = planGrown(this.input, this.inputEnd * 2, this.inputEnd)
      }
      const room: i32 = toI32(this.input.length) - this.inputEnd
      const got: i32 = netRead(this.fd, this.input, this.inputEnd, room)
      if (got === PLAN_AGAIN) {
        return true
      }
      if (got <= 0) {
        return false
      }
      this.inputEnd += got
      if (got < room) {
        return true
      }
    }
  }

  reset(): void {
    this.fd = -1
    this.inputStart = 0
    this.inputEnd = 0
    this.outputStart = 0
    this.outputEnd = 0
    this.armed = 0
  }
}

/** A read connection's socket. */
class PlanSocket {
  fd: i32 = -1
  connected: boolean = false
  armed: i32 = 0
}

/** The plan service's settings. */
export class PlanServiceConfig {
  pg: PgConfig
  host: string = "127.0.0.1"
  port: i32 = 5432
  /** Read connections, and plans in flight (one a connection). */
  conns: i32 = 5
  planMin: i32 = 256
  planWaitUs: i32 = 5000

  constructor() {
    this.pg = new PgConfig()
  }
}

/** The service: its workers, its queue of reads, its plans and its read connections. */
class PlanService {
  loop: i32 = -1
  listener: i32 = -1
  peers: PlanStream[]
  /** Each peer's generation, so a reply for a peer that went is dropped. */
  peerGen: i32[]
  pool: PgPool
  sockets: PlanSocket[]
  address: u8[]
  /** The reads waiting, a ring oldest first; their keys are windows of `keys`, which empties with the ring. */
  qPeer: i32[]
  qGen: i32[]
  qId: i32[]
  qKind: i32[]
  qViewer: i64[]
  qLimit: i64[]
  qOffset: i64[]
  qKeyStart: i32[]
  qKeyLen: i32[]
  qAt: i64[]
  qHead: i32 = 0
  qCount: i32 = 0
  keys: u8[]
  keyEnd: i32 = 0
  plans: ReadPlan[]
  planState: i32[]
  /** Each plan's reads, by their place in it: the peer, its generation, and the worker's id. */
  planPeer: i32[][]
  planGen: i32[][]
  planId: i32[][]
  /** Per ticket, by `ticket % PLAN_TICKETS`: the plan whose group it is, or -1. */
  ticketPlan: i32[]
  planMin: i32 = 256
  planWait: i64 = 5000000

  constructor(cfg: PlanServiceConfig, listener: i32, password: Secret<u8[]>) {
    this.listener = listener
    this.loop = pollCreate()
    pollAdd(this.loop, listener, 1, PLAN_LISTENER)
    this.peers = []
    this.peerGen = []
    for (let k: i32 = 0; k < PLAN_PEERS; k++) {
      this.peers.push(new PlanStream())
      this.peerGen.push(0)
    }
    const conns: i32 = cfg.conns < 1 ? 1 : cfg.conns
    // Every plan holds at most one group, so a connection never waits on two.
    cfg.pg.maxInFlight = 1
    this.pool = new PgPool(cfg.pg, password, conns, PLAN_QUEUE)
    registerPlanStatements(this.pool)
    this.sockets = []
    for (let k: i32 = 0; k < conns; k++) {
      this.sockets.push(new PlanSocket())
    }
    this.address = new Array<u8>(18)
    netAddress(this.address, cfg.host, cfg.port)
    this.qPeer = new Array<i32>(PLAN_QUEUE)
    this.qGen = new Array<i32>(PLAN_QUEUE)
    this.qId = new Array<i32>(PLAN_QUEUE)
    this.qKind = new Array<i32>(PLAN_QUEUE)
    this.qViewer = new Array<i64>(PLAN_QUEUE)
    this.qLimit = new Array<i64>(PLAN_QUEUE)
    this.qOffset = new Array<i64>(PLAN_QUEUE)
    this.qKeyStart = new Array<i32>(PLAN_QUEUE)
    this.qKeyLen = new Array<i32>(PLAN_QUEUE)
    this.qAt = new Array<i64>(PLAN_QUEUE)
    this.keys = new Array<u8>(1048576)
    this.plans = []
    this.planState = []
    this.planPeer = []
    this.planGen = []
    this.planId = []
    for (let k: i32 = 0; k < conns; k++) {
      this.plans.push(new ReadPlan())
      this.planState.push(PLAN_STATE_FREE)
      this.planPeer.push(new Array<i32>(PLAN_MAX))
      this.planGen.push(new Array<i32>(PLAN_MAX))
      this.planId.push(new Array<i32>(PLAN_MAX))
    }
    const noTypes: i32[] = []
    this.pool.register(this.plans[0].articles.name, this.plans[0].articles.sql, noTypes)
    this.pool.register(this.plans[0].comments.name, this.plans[0].comments.sql, noTypes)
    this.pool.register(this.plans[0].profiles.name, this.plans[0].profiles.sql, noTypes)
    this.ticketPlan = new Array<i32>(PLAN_TICKETS)
    for (let k: i32 = 0; k < PLAN_TICKETS; k++) {
      this.ticketPlan[k] = -1
    }
    this.planMin = cfg.planMin < 1 ? 1 : cfg.planMin > PLAN_MAX ? PLAN_MAX : cfg.planMin
    this.planWait = toI64(cfg.planWaitUs) * 1000
  }

  run(): i32 {
    const ready: i32[] = new Array<i32>(2 * 512)
    while (true) {
      this.pump()
      let wait: i32 = 1000
      const left: i64 = this.waitLeft()
      if (left > 0) {
        const ms: i32 = toI32((left + 999999) / 1000000)
        wait = ms < wait ? ms : wait
      }
      const n: i32 = pollWait(this.loop, ready, wait)
      if (n < 0 && n !== -4) {
        return 1
      }
      for (let k: i32 = 0; k < n; k++) {
        const token: i32 = ready[2 * k]
        const events: i32 = ready[2 * k + 1]
        if (token === PLAN_LISTENER) {
          this.acceptAll()
        } else if (token >= 0 && token < PLAN_PEERS) {
          this.peerReady(token, events)
        } else if (token <= PLAN_POOL_TOKEN) {
          const s: i32 = PLAN_POOL_TOKEN - token
          if (s < this.pool.size) {
            this.pgReady(s, events)
          }
        }
      }
    }
  }

  acceptAll(): void {
    const address: u8[] = new Array<u8>(18)
    let fd: i32 = tcpAccept(this.listener, address)
    while (fd >= 0) {
      let p: i32 = -1
      for (let j: i32 = 0; j < PLAN_PEERS && p < 0; j++) {
        if (this.peers[j].fd < 0) {
          p = j
        }
      }
      if (p < 0 || pollAdd(this.loop, fd, 1, p) < 0) {
        netClose(fd)
      } else {
        const peer: PlanStream = this.peers[p]
        peer.reset()
        peer.fd = fd
        peer.armed = 1
        this.peerGen[p] = this.peerGen[p] + 1
      }
      fd = tcpAccept(this.listener, address)
    }
  }

  peerReady(p: i32, events: i32): void {
    const peer: PlanStream = this.peers[p]
    if (peer.fd < 0) {
      return
    }
    let alive: boolean = true
    if ((events & PLAN_READABLE) !== 0) {
      alive = peer.receive()
      if (alive) {
        this.take(p)
      }
    }
    alive = alive && peer.send()
    if (!alive) {
      this.peerGone(p)
    } else {
      this.arm(p)
    }
  }

  /** Arms peer `p` for writing while it has output, only on a change. */
  arm(p: i32): void {
    const peer: PlanStream = this.peers[p]
    const wants: i32 = peer.outputEnd > peer.outputStart ? 3 : 1
    if (wants !== peer.armed) {
      peer.armed = wants
      pollModify(this.loop, peer.fd, wants, p)
    }
  }

  /** Peer `p` went: its reads still run, and their replies are dropped by its generation. */
  peerGone(p: i32): void {
    const peer: PlanStream = this.peers[p]
    pollRemove(this.loop, peer.fd)
    netClose(peer.fd)
    peer.reset()
    this.peerGen[p] = this.peerGen[p] + 1
  }

  /** Queues every whole request peer `p` has sent. */
  take(p: i32): void {
    const peer: PlanStream = this.peers[p]
    const b: u8[] = peer.input
    const now: i64 = monotonicNanos()
    while (peer.inputEnd - peer.inputStart >= PLAN_REQUEST_HEAD) {
      const at: i32 = peer.inputStart
      const keyLen: i32 = getU16(b, at + 29)
      const len: i32 = keyLen === PLAN_NO_KEY ? 0 : keyLen
      if (peer.inputEnd - at < PLAN_REQUEST_HEAD + len) {
        return
      }
      const id: i32 = getU32(b, at)
      peer.inputStart = at + PLAN_REQUEST_HEAD + len
      if (this.qCount === PLAN_QUEUE) {
        this.reply(p, this.peerGen[p], id, 500, b, 0, 0)
        continue
      }
      if (this.keyEnd + len > toI32(this.keys.length)) {
        this.compactKeys(len)
      }
      const q: i32 = (this.qHead + this.qCount) % PLAN_QUEUE
      this.qPeer[q] = p
      this.qGen[q] = this.peerGen[p]
      this.qId[q] = id
      this.qKind[q] = toI32(b[at + 4])
      this.qViewer[q] = getI64(b, at + 5)
      this.qLimit[q] = getI64(b, at + 13)
      this.qOffset[q] = getI64(b, at + 21)
      this.qKeyStart[q] = this.keyEnd
      this.qKeyLen[q] = keyLen === PLAN_NO_KEY ? -1 : keyLen
      this.qAt[q] = now
      copyBytes(this.keys, this.keyEnd, b, at + PLAN_REQUEST_HEAD, len)
      this.keyEnd += len
      this.qCount += 1
    }
  }

  /** Moves the waiting reads' keys to the front of `keys`, and grows it to fit `n` more. */
  compactKeys(n: i32): void {
    const fresh: u8[] = new Array<u8>(toI32(this.keys.length) * (this.keyEnd + n > toI32(this.keys.length) / 2 ? 2 : 1))
    let end: i32 = 0
    for (let k: i32 = 0; k < this.qCount; k++) {
      const q: i32 = (this.qHead + k) % PLAN_QUEUE
      const len: i32 = this.qKeyLen[q] > 0 ? this.qKeyLen[q] : 0
      copyBytes(fresh, end, this.keys, this.qKeyStart[q], len)
      this.qKeyStart[q] = end
      end += len
    }
    this.keys = planGrown(fresh, end + n, end)
    this.keyEnd = end
  }

  /** Queues a reply to read `id` of peer `p` (generation `gen`): `status` and `body[off, off + len)`. */
  reply(p: i32, gen: i32, id: i32, status: i32, body: u8[], off: i32, len: i32): void {
    const peer: PlanStream = this.peers[p]
    if (peer.fd < 0 || this.peerGen[p] !== gen) {
      return
    }
    peer.outputRoom(PLAN_REPLY_HEAD + len)
    const o: u8[] = peer.output
    const e: i32 = peer.outputEnd
    putU32(o, e, id)
    putU16(o, e + 4, status)
    putU32(o, e + 6, len)
    copyBytes(o, e + PLAN_REPLY_HEAD, body, off, len)
    peer.outputEnd = e + PLAN_REPLY_HEAD + len
  }

  /** How long, in ns, the reads waiting should wait still: 0 once `planMin` wait or the oldest has waited `planWait`. */
  waitLeft(): i64 {
    if (this.qCount === 0 || this.qCount >= this.planMin) {
      return 0
    }
    const left: i64 = this.qAt[this.qHead] + this.planWait - monotonicNanos()
    return left > 0 ? left : 0
  }

  /** Starts a plan in each free one while reads wait and their window has passed. */
  startPlans(): void {
    for (let p: i32 = 0; p < toI32(this.plans.length) && this.qCount > 0; p++) {
      if (this.planState[p] !== PLAN_STATE_FREE) {
        continue
      }
      if (this.waitLeft() > 0) {
        return
      }
      const ticket: i32 = this.pool.request()
      if (ticket === PG_POOL_FULL) {
        return
      }
      const plan: ReadPlan = this.plans[p]
      plan.reset()
      while (this.qCount > 0) {
        const q: i32 = this.qHead
        const i: i32 = plan.count
        if (
          !plan.add(i, this.qKind[q], this.qViewer[q], this.qLimit[q], this.qOffset[q], this.keys, this.qKeyStart[q], this.qKeyLen[q])
        ) {
          break
        }
        this.planPeer[p][i] = this.qPeer[q]
        this.planGen[p][i] = this.qGen[q]
        this.planId[p][i] = this.qId[q]
        this.qHead = (this.qHead + 1) % PLAN_QUEUE
        this.qCount -= 1
      }
      if (this.qCount === 0) {
        this.keyEnd = 0
      }
      this.ticketPlan[ticket % PLAN_TICKETS] = p
      this.planState[p] = PLAN_STATE_A
    }
  }

  /** Plan `p`'s group ended: after group A, asks for group B when it has anything to read, else answers. */
  groupDone(p: i32): void {
    const plan: ReadPlan = this.plans[p]
    if (this.planState[p] === PLAN_STATE_A) {
      if (plan.failed) {
        plan.abortA()
        this.finish(p, false)
        return
      }
      if (plan.planB()) {
        const ticket: i32 = this.pool.request()
        if (ticket !== PG_POOL_FULL) {
          this.ticketPlan[ticket % PLAN_TICKETS] = p
          this.planState[p] = PLAN_STATE_B
          return
        }
        plan.failed = true
      }
    }
    this.finish(p, false)
  }

  /** Answers every read of plan `p` and frees it. */
  finish(p: i32, lost: boolean): void {
    const plan: ReadPlan = this.plans[p]
    for (let i: i32 = 0; i < plan.count; i++) {
      const peer: i32 = this.planPeer[p][i]
      const gen: i32 = this.planGen[p][i]
      const id: i32 = this.planId[p][i]
      if (lost) {
        this.reply(peer, gen, id, 500, plan.out, 0, 0)
        continue
      }
      const status: i32 = plan.failed ? PLAN_ALONE : plan.render(i)
      if (status === PLAN_ALONE) {
        this.reply(peer, gen, id, PLAN_REPLY_ALONE, plan.out, 0, 0)
      } else if (status === 200) {
        this.reply(peer, gen, id, 200, plan.out, 0, plan.outEnd)
      } else {
        this.reply(peer, gen, id, status, plan.out, 0, 0)
      }
    }
    this.planState[p] = PLAN_STATE_FREE
  }

  /** One event of a plan's group. */
  planEvent(ticket: i32, conn: PgConnection, event: i32): void {
    const at: i32 = ticket % PLAN_TICKETS
    const p: i32 = this.ticketPlan[at]
    const plan: ReadPlan = this.plans[p]
    if (event === PG_LOST) {
      this.ticketPlan[at] = -1
      plan.abortA()
      this.finish(p, true)
    } else if (event === PG_GROUP_DONE) {
      this.ticketPlan[at] = -1
      if (conn.groupFailed) {
        plan.failed = true
      }
      this.groupDone(p)
    } else if (this.planState[p] === PLAN_STATE_A) {
      plan.eventA(conn, event)
    } else {
      plan.eventB(conn, event)
    }
  }

  /** Starts the plans that are due, binds their groups, opens the connections wanted, and sends. */
  pump(): void {
    this.startPlans()
    const pool: PgPool = this.pool
    let s: i32 = pool.dispatch()
    while (s >= 0) {
      const conn: PgConnection = pool.connection(s)
      const at: i32 = pool.ticket % PLAN_TICKETS
      const pi: i32 = this.ticketPlan[at]
      if (pi >= 0) {
        const plan: ReadPlan = this.plans[pi]
        const bound: boolean = this.planState[pi] === PLAN_STATE_A ? plan.bindA(conn) : plan.bindB(conn)
        if (!bound) {
          plan.failed = true
          conn.bindCancel()
        }
        if (!pool.send()) {
          this.ticketPlan[at] = -1
          plan.failed = true
          this.groupDone(pi)
        }
      }
      s = pool.dispatch()
    }
    s = pool.wanted()
    while (s >= 0 && s < pool.size) {
      const socket: PlanSocket = this.sockets[s]
      const nonce = new Array<u8>(18)
      crypto.getRandomValues(nonce)
      pool.connect(s, nonce)
      socket.fd = tcpConnect(this.address)
      socket.connected = false
      socket.armed = 2
      if (socket.fd < 0 || pollAdd(this.loop, socket.fd, 2, PLAN_POOL_TOKEN - s) < 0) {
        pool.connection(s).closed()
        this.pgEvents(s)
      }
      s = pool.wanted()
    }
    for (let k: i32 = 0; k < pool.size; k++) {
      const socket: PlanSocket = this.sockets[k]
      if (socket.fd >= 0 && socket.connected) {
        const conn: PgConnection = pool.connection(k)
        if (!this.pgFlush(conn, socket.fd)) {
          conn.closed()
          this.pgEvents(k)
        } else if (socket.fd >= 0) {
          const wants: i32 = conn.outputEnd() > conn.outputStart() ? 3 : 1
          if (wants !== socket.armed) {
            socket.armed = wants
            pollModify(this.loop, socket.fd, wants, PLAN_POOL_TOKEN - k)
          }
        }
      }
    }
    for (let p: i32 = 0; p < PLAN_PEERS; p++) {
      const peer: PlanStream = this.peers[p]
      if (peer.fd >= 0 && peer.outputEnd > peer.outputStart) {
        if (!peer.send()) {
          this.peerGone(p)
        } else {
          this.arm(p)
        }
      }
    }
  }

  pgFlush(conn: PgConnection, fd: i32): boolean {
    while (conn.outputEnd() > conn.outputStart()) {
      const n: i32 = netWrite(fd, conn.outputBuffer(), conn.outputStart(), conn.outputEnd() - conn.outputStart())
      if (n === PLAN_AGAIN) {
        return true
      }
      if (n <= 0) {
        return false
      }
      conn.sent(n)
    }
    return true
  }

  pgReady(s: i32, events: i32): void {
    const socket: PlanSocket = this.sockets[s]
    if (socket.fd < 0) {
      return
    }
    const conn: PgConnection = this.pool.connection(s)
    if (!socket.connected) {
      if (connectResult(socket.fd) === 0) {
        socket.connected = true
      } else {
        conn.closed()
      }
      this.pgEvents(s)
      return
    }
    if ((events & PLAN_READABLE) !== 0) {
      while (true) {
        let room: i32 = conn.inputRoom()
        if (room <= 0) {
          this.pgEvents(s)
          if (socket.fd < 0) {
            return
          }
          room = conn.inputRoom()
          if (room <= 0) {
            break
          }
        }
        const got: i32 = netRead(socket.fd, conn.inputBuffer(), conn.inputEnd(), room)
        if (got === PLAN_AGAIN) {
          break
        }
        if (got <= 0) {
          conn.closed()
          break
        }
        conn.received(got)
        if (got < room) {
          break
        }
        this.pgEvents(s)
        if (socket.fd < 0) {
          return
        }
      }
    }
    this.pgEvents(s)
  }

  pgEvents(s: i32): void {
    const pool: PgPool = this.pool
    const conn: PgConnection = pool.connection(s)
    let event: i32 = pool.next(s)
    while (event !== PG_NEED_MORE) {
      if (event === PG_FAILED) {
        const socket: PlanSocket = this.sockets[s]
        if (socket.fd >= 0) {
          pollRemove(this.loop, socket.fd)
          netClose(socket.fd)
          socket.fd = -1
          socket.connected = false
        }
        return
      }
      const ticket: i32 = pool.ticket
      if (ticket >= 0 && this.ticketPlan[ticket % PLAN_TICKETS] >= 0) {
        this.planEvent(ticket, conn, event)
      }
      event = pool.next(s)
    }
  }
}

/** Serves the workers on `listener` until the process is stopped. Answers only on a failure to poll. */
export const runPlanService = (cfg: PlanServiceConfig, listener: i32, password: Secret<u8[]>): i32 =>
  new PlanService(cfg, listener, password).run()

/**
 * A worker's end of the service: reads queued with `request`, sent by the
 * worker's loop, and replies read with `nextReply` after `receive`. The
 * worker owns the socket and its readiness.
 */
export class PlanClient {
  stream: PlanStream
  connected: boolean = false
  address: u8[]
  /** When a connect last failed (0 while none has) and when to try again. */
  failedAt: i64 = 0
  retryAt: i64 = 0
  /** The reply `nextReply` read: its id, status and body, a window of `input`. */
  replyId: i32 = 0
  replyStatus: i32 = 0
  replyStart: i32 = 0
  replyLength: i32 = 0

  constructor() {
    this.stream = new PlanStream()
    this.address = new Array<u8>(18)
  }

  fd(): i32 {
    return this.stream.fd
  }

  waiting(): boolean {
    return this.stream.outputEnd > this.stream.outputStart
  }

  /** Queues read `id`: its kind, viewer, limit, offset and key `src[start, start + len)` (len -1 for none). */
  request(id: i32, kind: i32, viewer: i64, limit: i64, offset: i64, src: u8[], start: i32, len: i32): void {
    const n: i32 = len > 0 ? len : 0
    const s: PlanStream = this.stream
    s.outputRoom(PLAN_REQUEST_HEAD + n)
    const o: u8[] = s.output
    const e: i32 = s.outputEnd
    putU32(o, e, id)
    o[e + 4] = toU8(kind)
    putI64(o, e + 5, viewer)
    putI64(o, e + 13, limit)
    putI64(o, e + 21, offset)
    putU16(o, e + 29, len < 0 ? PLAN_NO_KEY : len)
    copyBytes(o, e + PLAN_REQUEST_HEAD, src, start, n)
    s.outputEnd = e + PLAN_REQUEST_HEAD + n
  }

  send(): boolean {
    return this.stream.send()
  }

  receive(): boolean {
    return this.stream.receive()
  }

  /** Reads the next whole reply; false when none is whole yet. Its body stays valid until the next `receive`. */
  nextReply(): boolean {
    const s: PlanStream = this.stream
    const b: u8[] = s.input
    const at: i32 = s.inputStart
    if (s.inputEnd - at < PLAN_REPLY_HEAD) {
      return false
    }
    const len: i32 = getU32(b, at + 6)
    if (s.inputEnd - at < PLAN_REPLY_HEAD + len) {
      return false
    }
    this.replyId = getU32(b, at)
    this.replyStatus = getU16(b, at + 4)
    this.replyStart = at + PLAN_REPLY_HEAD
    this.replyLength = len
    s.inputStart = at + PLAN_REPLY_HEAD + len
    return true
  }

  input(): u8[] {
    return this.stream.input
  }

  /** Forgets the connection and what was queued for it. */
  reset(): void {
    this.stream.reset()
    this.connected = false
  }
}
