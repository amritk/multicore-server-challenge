// JSON written straight into a byte array, for the rows the server answers
// most: an article is the same fourteen keys every time, so its fixed text
// is copied in as pre-encoded fragments and only the column values are
// escaped. `JsonWriter` is the general writer; this is the fast path beside
// it, and the worker falls back to `JsonWriter` whenever a row might not fit
// or a tag list needs `PgArrayWalker`.
//
// The escapes are `JSON.stringify`'s, as `JsonWriter`'s are: `"` and `\`, the
// five short escapes for backspace, form feed, line feed, carriage return and
// tab, `\u00xx` for every other byte below 0x20, and every other byte, UTF-8
// included, as itself. Each function answers the index after what it wrote;
// the caller has made sure the room is there.
import { copyBytes, skipJsonPlain } from "nish/bytes"

/** The two-letter escape of `c`, or 0 when it has none. */
const jsonOutShort = (c: i32): i32 => {
  if (c === 34) {
    return 34
  }
  if (c === 92) {
    return 92
  }
  if (c === 8) {
    return 98
  }
  if (c === 12) {
    return 102
  }
  if (c === 10) {
    return 110
  }
  if (c === 13) {
    return 114
  }
  if (c === 9) {
    return 116
  }
  return 0
}

const jsonOutHex = (v: i32): i32 => (v < 10 ? 48 + v : 87 + v)

/** The most bytes `jsonOutString` writes for `len` bytes of text: quotes and a six-byte escape each. */
export const jsonOutWorst = (len: i32): i32 => 6 * len + 2

/** `b[off, off + len)` as a JSON string at `out[o]`: runs of plain bytes copied whole, the rest escaped. */
export const jsonOutString = (out: u8[], o: i32, b: u8[], off: i32, len: i32): i32 => {
  let at: i32 = o
  out[at] = toU8(34)
  at++
  const stop: i32 = off + len
  let i: i32 = off
  while (i < stop) {
    const run: i32 = skipJsonPlain(b, i, stop)
    if (run > i) {
      copyBytes(out, at, b, i, run - i)
      at += run - i
      i = run
    }
    if (i >= stop) {
      break
    }
    const c: i32 = toI32(b[i])
    i++
    const letter: i32 = jsonOutShort(c)
    out[at] = toU8(92)
    if (letter !== 0) {
      out[at + 1] = toU8(letter)
      at += 2
    } else {
      out[at + 1] = toU8(117)
      out[at + 2] = toU8(48)
      out[at + 3] = toU8(48)
      out[at + 4] = toU8(jsonOutHex(c >> 4))
      out[at + 5] = toU8(jsonOutHex(c & 15))
      at += 6
    }
  }
  out[at] = toU8(34)
  return at + 1
}

/** `frag` copied whole at `out[o]`. */
export const jsonOutRaw = (out: u8[], o: i32, frag: u8[]): i32 => {
  copyBytes(out, o, frag, 0, toI32(frag.length))
  return o + toI32(frag.length)
}

/** `true` or `false` at `out[o]`. */
export const jsonOutBool = (out: u8[], o: i32, v: boolean): i32 => {
  if (v) {
    out[o] = toU8(116)
    out[o + 1] = toU8(114)
    out[o + 2] = toU8(117)
    out[o + 3] = toU8(101)
    return o + 4
  }
  out[o] = toU8(102)
  out[o + 1] = toU8(97)
  out[o + 2] = toU8(108)
  out[o + 3] = toU8(115)
  out[o + 4] = toU8(101)
  return o + 5
}

/** `null` at `out[o]`. */
export const jsonOutNull = (out: u8[], o: i32): i32 => {
  out[o] = toU8(110)
  out[o + 1] = toU8(117)
  out[o + 2] = toU8(108)
  out[o + 3] = toU8(108)
  return o + 4
}

/**
 * The `text[]` text `b[start, start + len)` as a JSON array of strings at
 * `out[o]`, or -1 with nothing promised about `out` when it is not one this
 * path writes. Postgres quotes an element that holds a quote, a backslash, a
 * comma, a brace or white space, so a text with no quote in it is its
 * elements and commas; when every byte is one JSON writes as itself
 * (`skipJsonPlain`, a vector scan), the array is one pass of block copies.
 * A quoted element, a byte JSON escapes, an unquoted NULL (a null element)
 * and a text that is not `{...}` answer -1, for `PgArrayWalker`. It writes
 * at most `2 * len + 2` bytes.
 */
export const jsonOutTextArray = (out: u8[], o: i32, b: u8[], start: i32, len: i32): i32 => {
  if (len < 2 || toI32(b[start]) !== 123 || toI32(b[start + len - 1]) !== 125) {
    return -1
  }
  const end: i32 = start + len - 1
  if (skipJsonPlain(b, start + 1, end) !== end) {
    return -1
  }
  out[o] = toU8(91)
  let at: i32 = o + 1
  let from: i32 = start + 1
  while (from < end) {
    let to: i32 = from
    while (to < end && toI32(b[to]) !== 44) {
      to++
    }
    if (
      to - from === 4 &&
      (toI32(b[from]) | 32) === 110 &&
      (toI32(b[from + 1]) | 32) === 117 &&
      (toI32(b[from + 2]) | 32) === 108 &&
      (toI32(b[from + 3]) | 32) === 108
    ) {
      return -1
    }
    if (at > o + 1) {
      out[at] = toU8(44)
      at++
    }
    out[at] = toU8(34)
    copyBytes(out, at + 1, b, from, to - from)
    at += to - from + 1
    out[at] = toU8(34)
    at++
    from = to + 1
  }
  out[at] = toU8(93)
  return at + 1
}
