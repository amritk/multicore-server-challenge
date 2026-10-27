// A RealWorld "Conduit" server for the multicore server challenge
// (https://github.com/arjaythedev/multicore-server-challenge), in Nish on its
// standard library: nish/net/http1-server, nish/net/postgres, nish/json,
// nish/crypto's HMAC and bcrypt, nish/net/prefork. README.md has the design
// and the measurements.
//
// One supervisor and HTTP_WORKERS + 1 worker processes (nish/net/prefork,
// restarts off: the challenge's rule 9 does not restart a crashed server, so
// neither does this). Workers 0 to HTTP_WORKERS - 1 each bind HOST:PORT with
// SO_REUSEPORT and serve HTTP on their own loop and their own Postgres
// connections; the last runs the bcrypt service on 127.0.0.1:BCRYPT_PORT.
//
// Configured by the environment only: DATABASE_URL, JWT_SECRET, HOST, PORT
// (the challenge's), and optionally HTTP_WORKERS (2), DB_READ_CONNS (3) and
// DB_WRITE_CONNS (1) per worker, DB_MAX_IN_FLIGHT (16), DB_READ_IN_FLIGHT (4)
// for the read connections, DB_READ_PLANS (DB_READ_CONNS) read plans in flight
// per worker, READ_PLAN_MIN (256), READ_PLAN_WAIT_US (10000) and
// READ_PLAN_CLOCK (1) for when a plan starts (worker.ts, `planWaitLeft`),
// BCRYPT_BATCH_MS (160), BCRYPT_PORT (47391) and IDLE_TIMEOUT_MS (75000).
import { tcpListenFlags } from "nish:net"
import { getenv } from "nish:process"
import { PREFORK_STOPPED, PreforkConfig, preforkWith } from "nish/net/prefork"
import { runBcryptService } from "./bcrypt-service"
import { ConduitWorker, WorkerConfig } from "./worker"

/** `tcpListenFlags`: SO_REUSEPORT, and TCP_NODELAY on every accepted socket. */
const LISTEN_FLAGS: i32 = 3

/** The environment variable `name` as a positive number, or `fallback`. */
const envInt = (name: string, fallback: i32): i32 => {
  const v: string | null = getenv(name)
  if (v === null || v.length === 0 || v.length > 9) {
    return fallback
  }
  for (let k: i32 = 0; k < toI32(v.length); k++) {
    const c: i32 = toI32(v.charCodeAt(k))
    if (c < 48 || c > 57) {
      return fallback
    }
  }
  const n: i32 = parseInt(v)
  return n > 0 ? n : fallback
}

/** The last index of `c` in `s`, or -1. */
const lastIndexOfByte = (s: string, c: i32): i32 => {
  for (let k: i32 = toI32(s.length) - 1; k >= 0; k--) {
    if (toI32(s.charCodeAt(k)) === c) {
      return k
    }
  }
  return -1
}

/** Reads `postgres://user:password@host:port/database` into `cfg`; false when it is not that shape. */
const readDatabaseUrl = (url: string, cfg: WorkerConfig): boolean => {
  const scheme: i32 = url.indexOf("://")
  if (scheme < 0) {
    return false
  }
  const rest: string = url.substring(scheme + 3)
  const at: i32 = lastIndexOfByte(rest, 64)
  const slash: i32 = rest.indexOf("/", at < 0 ? 0 : at)
  if (at < 0 || slash < 0) {
    return false
  }
  const userInfo: string = rest.substring(0, at)
  const colon: i32 = userInfo.indexOf(":")
  cfg.dbUser = colon < 0 ? userInfo : userInfo.substring(0, colon)
  cfg.dbPassword = colon < 0 ? "" : userInfo.substring(colon + 1)
  const hostPort: string = rest.substring(at + 1, slash)
  const portAt: i32 = lastIndexOfByte(hostPort, 58)
  cfg.dbHost = portAt < 0 ? hostPort : hostPort.substring(0, portAt)
  cfg.dbPort = portAt < 0 ? 5432 : parseInt(hostPort.substring(portAt + 1))
  const query: i32 = rest.indexOf("?", slash)
  cfg.dbName = query < 0 ? rest.substring(slash + 1) : rest.substring(slash + 1, query)
  if (cfg.dbHost === "localhost") {
    cfg.dbHost = "127.0.0.1"
  }
  return cfg.dbUser.length > 0 && cfg.dbName.length > 0 && cfg.dbPort > 0
}

export const main = (): i32 => {
  const cfg = new WorkerConfig()
  if (!readDatabaseUrl(getenv("DATABASE_URL") ?? "", cfg)) {
    console.log("conduit: DATABASE_URL is not postgres://user:password@host:port/database")
    return 2
  }
  if ((getenv("JWT_SECRET") ?? "").length === 0) {
    console.log("conduit: JWT_SECRET is not set")
    return 2
  }
  cfg.host = getenv("HOST") ?? "0.0.0.0"
  cfg.port = envInt("PORT", 3000)
  cfg.readConns = envInt("DB_READ_CONNS", 3)
  cfg.writeConns = envInt("DB_WRITE_CONNS", 1)
  cfg.maxInFlight = envInt("DB_MAX_IN_FLIGHT", 16)
  cfg.readInFlight = envInt("DB_READ_IN_FLIGHT", 4)
  cfg.readPlans = envInt("DB_READ_PLANS", cfg.readConns)
  cfg.planMin = envInt("READ_PLAN_MIN", 256)
  cfg.planWaitUs = envInt("READ_PLAN_WAIT_US", 10000)
  cfg.planClock = (getenv("READ_PLAN_CLOCK") ?? "1") !== "0"
  cfg.bcryptPort = envInt("BCRYPT_PORT", 47391)
  cfg.idleTimeoutMs = envInt("IDLE_TIMEOUT_MS", 75000)
  const http: i32 = envInt("HTTP_WORKERS", 2)
  const prefork = new PreforkConfig()
  prefork.workers = http + 1
  prefork.restart = false
  const index: i32 = preforkWith(process.argv, prefork)
  if (index < 0) {
    return index === PREFORK_STOPPED ? 0 : 1
  }
  if (index === http) {
    const listener: i32 = tcpListenFlags("127.0.0.1", cfg.bcryptPort, 1024, 2)
    if (listener < 0) {
      console.log(`conduit: the bcrypt service cannot listen on 127.0.0.1:${cfg.bcryptPort} (${listener})`)
      return 1
    }
    return runBcryptService(listener, envInt("BCRYPT_BATCH_MS", 160))
  }
  const listener: i32 = tcpListenFlags(cfg.host, cfg.port, cfg.backlog, LISTEN_FLAGS)
  if (listener < 0) {
    console.log(`conduit: cannot listen on ${cfg.host}:${cfg.port} (${listener})`)
    return 1
  }
  if (index === 0) {
    console.log(`conduit: ${http} workers on ${cfg.host}:${cfg.port}`)
  }
  return new ConduitWorker(cfg, listener).run()
}
