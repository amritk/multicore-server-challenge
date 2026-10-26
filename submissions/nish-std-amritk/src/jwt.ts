// The Conduit tokens: HS256 JWTs whose claims are exactly
// {"sub": "<user id>", "iat": <now>, "exp": <now + 30 days>}, as the multicore
// server challenge's SPEC.md "Authentication" defines them. Every request's
// token has its signature and `exp` checked here; nothing is remembered from
// one request to the next (the challenge's rule 5).
//
// The key's pads are absorbed once (`keyed`), and each signature copies the
// two keyed SHA-256 states and feeds them the message, so a token costs the
// message's blocks and two finishing blocks, not the key's two again. Every
// base64url step reads and writes caller-owned arrays; what a request
// allocates here is the digests `HmacSha256.digest` returns.
import { timingSafeEqualAt } from "nish/crypto/ct"
import { HmacSha256, hmacCopySha256 } from "nish/crypto/hmac"
import {
  JSON_TOK_KEY,
  JSON_TOK_OBJECT_BEGIN,
  JSON_TOK_OBJECT_END,
  JSON_TOK_STRING,
  JSON_TOK_NUMBER,
  JsonLimits,
  JsonTokenizer,
} from "nish/json-tokenizer"

/** Thirty days, the lifetime SPEC.md gives a token, in seconds. */
export const JWT_LIFETIME: i64 = 2592000
/** The longest token `verify` reads; a longer one is refused unread. */
const JWT_MAX_TOKEN: i32 = 2048
/** base64url of `{"alg":"HS256","typ":"JWT"}`, every issued token's header. */
const JWT_HEADER: string = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
const JWT_ALPHABET: string = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** The sextet base64url gives the byte `c`, or -1 when `c` is not in its alphabet. */
const jwtSextet = (c: i32): i32 => {
  if (c >= 65 && c <= 90) {
    return c - 65
  }
  if (c >= 97 && c <= 122) {
    return c - 71
  }
  if (c >= 48 && c <= 57) {
    return c + 4
  }
  if (c === 45) {
    return 62
  }
  if (c === 95) {
    return 63
  }
  return -1
}

/**
 * Decodes unpadded base64url `src[off, off + len)` into `out` from 0, and
 * answers the bytes written; -1 for a byte outside the alphabet, a length
 * no encoding has (1 mod 4), stray bits in the last sextet, or no room.
 */
export const jwtDecode = (src: u8[], off: i32, len: i32, out: u8[]): i32 => {
  if (off < 0 || len < 0 || off + len > toI32(src.length) || len % 4 === 1) {
    return -1
  }
  const n: i32 = (len * 3) >> 2
  if (n > toI32(out.length)) {
    return -1
  }
  let acc: i32 = 0
  let bits: i32 = 0
  let o: i32 = 0
  for (let k: i32 = off; k < off + len; k++) {
    const v: i32 = jwtSextet(toI32(src[k]))
    if (v < 0) {
      return -1
    }
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      if (o >= toI32(out.length)) {
        return -1
      }
      out[o] = toU8((acc >> bits) & 255)
      o++
    }
  }
  // RFC 4648 §3.5: the bits past the last whole byte are zero in a canonical encoding.
  if ((acc & ((1 << bits) - 1)) !== 0) {
    return -1
  }
  return o
}

/** Encodes `src[off, off + len)` as unpadded base64url into `out` at `at`; answers the end. */
export const jwtEncode = (src: u8[], off: i32, len: i32, out: u8[], at: i32): i32 => {
  let o: i32 = at
  let k: i32 = off
  const end: i32 = off + len
  while (k + 2 < end) {
    const v: i32 = (toI32(src[k]) << 16) | (toI32(src[k + 1]) << 8) | toI32(src[k + 2])
    out[o] = toU8(JWT_ALPHABET.charCodeAt((v >> 18) & 63))
    out[o + 1] = toU8(JWT_ALPHABET.charCodeAt((v >> 12) & 63))
    out[o + 2] = toU8(JWT_ALPHABET.charCodeAt((v >> 6) & 63))
    out[o + 3] = toU8(JWT_ALPHABET.charCodeAt(v & 63))
    o += 4
    k += 3
  }
  if (end - k === 1) {
    const v: i32 = toI32(src[k]) << 16
    out[o] = toU8(JWT_ALPHABET.charCodeAt((v >> 18) & 63))
    out[o + 1] = toU8(JWT_ALPHABET.charCodeAt((v >> 12) & 63))
    o += 2
  } else if (end - k === 2) {
    const v: i32 = (toI32(src[k]) << 16) | (toI32(src[k + 1]) << 8)
    out[o] = toU8(JWT_ALPHABET.charCodeAt((v >> 18) & 63))
    out[o + 1] = toU8(JWT_ALPHABET.charCodeAt((v >> 12) & 63))
    out[o + 2] = toU8(JWT_ALPHABET.charCodeAt((v >> 6) & 63))
    o += 3
  }
  return o
}

/** Writes `v`'s decimal digits into `out` at `at`; answers the end. */
export const jwtDigits = (v: i64, out: u8[], at: i32): i32 => {
  let n: i64 = v < 0 ? -v : v
  let len: i32 = 1
  let probe: i64 = n
  while (probe >= 10) {
    probe = probe / 10
    len++
  }
  let o: i32 = at
  if (v < 0) {
    out[o] = toU8(45)
    o++
  }
  for (let k: i32 = len - 1; k >= 0; k--) {
    out[o + k] = toU8(48 + toI32(n % 10))
    n = n / 10
  }
  return o + len
}

/** Writes the ASCII `s` into `out` at `at`; answers the end. */
const jwtAscii = (s: string, out: u8[], at: i32): i32 => {
  for (let k: i32 = 0; k < toI32(s.length); k++) {
    out[at + k] = toU8(s.charCodeAt(k))
  }
  return at + toI32(s.length)
}

/** The signer and verifier of one secret's tokens. */
export class Jwt {
  /** The two pads, absorbed once; `work` starts each signature from copies of them. */
  keyed: HmacSha256
  work: HmacSha256
  /** A decoded header or payload, and a decoded signature. */
  part: u8[]
  sig: u8[]
  /** A payload being written, before its encoding. */
  claims: u8[]
  tokenizer: JsonTokenizer
  /** `JWT_HEADER`'s bytes, which most tokens' first part is. */
  header: u8[]
  /** What the last `verify` found: the `sub` claim. */
  sub: i64 = 0

  constructor(secret: u8[]) {
    this.keyed = new HmacSha256(secret)
    this.work = new HmacSha256(secret)
    this.part = new Array<u8>(JWT_MAX_TOKEN)
    this.sig = new Array<u8>(64)
    this.claims = new Array<u8>(128)
    this.header = new Array<u8>(JWT_HEADER.length)
    jwtAscii(JWT_HEADER, this.header, 0)
    const limits = new JsonLimits()
    limits.maxDepth = 4
    this.tokenizer = new JsonTokenizer(this.part, 0, 0, limits)
  }

  /** The HMAC-SHA-256 of `src[off, off + len)` written at `out[at]`. */
  sign(src: u8[], off: i32, len: i32, out: u8[], at: i32): void {
    hmacCopySha256(this.keyed.inner, this.work.inner)
    hmacCopySha256(this.keyed.outer, this.work.outer)
    this.work.update(src, off, len)
    const tag: u8[] = this.work.digest()
    for (let k: i32 = 0; k < 32; k++) {
      out[at + k] = tag[k]
    }
  }

  /**
   * Writes a fresh token for user `id` at `out[at]`, issued at `now`
   * (seconds), and answers its end. `out` needs about 200 bytes of room.
   */
  issue(id: i64, now: i64, out: u8[], at: i32): i32 {
    const c: u8[] = this.claims
    let n: i32 = jwtAscii('{"sub":"', c, 0)
    n = jwtDigits(id, c, n)
    n = jwtAscii('","iat":', c, n)
    n = jwtDigits(now, c, n)
    n = jwtAscii(',"exp":', c, n)
    n = jwtDigits(now + JWT_LIFETIME, c, n)
    n = jwtAscii("}", c, n)
    let o: i32 = jwtAscii(JWT_HEADER, out, at)
    out[o] = toU8(46)
    o = jwtEncode(c, 0, n, out, o + 1)
    this.sign(out, at, o - at, this.sig, 0)
    out[o] = toU8(46)
    return jwtEncode(this.sig, 0, 32, out, o + 1)
  }

  /**
   * Whether `src[off, off + len)` is a token this secret signed with HS256
   * whose `exp` is after `now` (seconds) and whose `sub` is a decimal user
   * id, which it leaves in `sub`. Any other `alg`, a missing `exp`, and a
   * numeric `sub` are refused, as SPEC.md asks.
   */
  verify(src: u8[], off: i32, len: i32, now: i64): boolean {
    if (len <= 0 || len > JWT_MAX_TOKEN || off < 0 || off + len > toI32(src.length)) {
      return false
    }
    let first: i32 = -1
    let second: i32 = -1
    for (let k: i32 = off; k < off + len; k++) {
      if (toI32(src[k]) === 46) {
        if (first < 0) {
          first = k
        } else if (second < 0) {
          second = k
        } else {
          return false
        }
      }
    }
    if (first < 0 || second < 0) {
      return false
    }
    const sigLen: i32 = jwtDecode(src, second + 1, off + len - second - 1, this.sig)
    if (sigLen !== 32) {
      return false
    }
    this.sign(src, off, second - off, this.part, 0)
    if (!timingSafeEqualAt(this.part, 0, this.sig, 0, 32)) {
      return false
    }
    // Every token this server issues has the one header, whose `alg` is
    // HS256; any other header is decoded and read.
    if (!this.isIssuedHeader(src, off, first - off)) {
      const headerLen: i32 = jwtDecode(src, off, first - off, this.part)
      if (headerLen < 0 || !this.headerIsHs256(headerLen)) {
        return false
      }
    }
    const payloadLen: i32 = jwtDecode(src, first + 1, second - first - 1, this.part)
    return payloadLen >= 0 && this.claimsValid(payloadLen, now)
  }

  /** Whether `src[off, off + len)` is exactly `JWT_HEADER`. */
  isIssuedHeader(src: u8[], off: i32, len: i32): boolean {
    const h: u8[] = this.header
    if (len !== toI32(h.length)) {
      return false
    }
    for (let k: i32 = 0; k < len; k++) {
      if (src[off + k] !== h[k]) {
        return false
      }
    }
    return true
  }

  /** Whether the header in `part[0, len)` is an object whose `alg` is exactly `HS256`. */
  headerIsHs256(len: i32): boolean {
    const t: JsonTokenizer = this.tokenizer
    t.reset(this.part, 0, len)
    if (t.next() !== JSON_TOK_OBJECT_BEGIN) {
      return false
    }
    let alg: boolean = false
    let k: i32 = t.next()
    while (k === JSON_TOK_KEY) {
      if (t.keyEquals("alg")) {
        if (t.next() !== JSON_TOK_STRING || !t.keyEquals("HS256")) {
          return false
        }
        alg = true
      } else if (t.skipValue() < 0) {
        return false
      }
      k = t.next()
    }
    return k === JSON_TOK_OBJECT_END && alg && t.next() === 0 && t.failed === 0
  }

  /** Whether the payload in `part[0, len)` has a decimal-string `sub` and an integer `exp` after `now`. */
  claimsValid(len: i32, now: i64): boolean {
    const t: JsonTokenizer = this.tokenizer
    t.reset(this.part, 0, len)
    if (t.next() !== JSON_TOK_OBJECT_BEGIN) {
      return false
    }
    let sub: i64 = -1
    let exp: i64 = -1
    let k: i32 = t.next()
    while (k === JSON_TOK_KEY) {
      if (t.keyEquals("sub")) {
        if (t.next() !== JSON_TOK_STRING) {
          return false
        }
        sub = this.decimal(t.tokStart + 1, t.tokEnd - 1)
        if (sub <= 0) {
          return false
        }
      } else if (t.keyEquals("exp")) {
        if (t.next() !== JSON_TOK_NUMBER || !t.isInteger()) {
          return false
        }
        exp = t.numberI64()
      } else if (t.skipValue() < 0) {
        return false
      }
      k = t.next()
    }
    if (k !== JSON_TOK_OBJECT_END || t.next() !== 0 || t.failed !== 0) {
      return false
    }
    if (sub <= 0 || exp <= now) {
      return false
    }
    this.sub = sub
    return true
  }

  /** `part[start, end)` read as 1 to 18 decimal digits; -1 otherwise. */
  decimal(start: i32, end: i32): i64 {
    if (end <= start || end - start > 18) {
      return -1
    }
    let v: i64 = 0
    for (let k: i32 = start; k < end; k++) {
      const d: i32 = toI32(this.part[k]) - 48
      if (d < 0 || d > 9) {
        return -1
      }
      v = v * 10 + toI64(d)
    }
    return v
  }
}
