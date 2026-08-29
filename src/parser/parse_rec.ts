/**
 * JavaScript port of parse_rec.py -- parse an AoE2 (DE) recorded game and build
 * the same human-readable summary, with no Python and no mgz install.
 *
 * The Python script is a thin report writer on top of `mgz.model.parse_match`,
 * so almost everything here is a port of mgz itself: `mgz.fast.header`,
 * `mgz.fast` (body ops), `mgz.fast.actions`, `mgz.common.{chat,map,diplomacy}`
 * and `mgz.model`. It also folds in both monkeypatches from mgz_patch.py --
 * save-version 68 player records and AI-issued RESEARCH -- since parse_rec.py
 * imports that module before parsing. Deviations from the Python are marked
 * with a `PORT:` comment.
 *
 * Reference data (civilizations, objects, technologies, colors, ...) comes from
 * the `aocref` package; a copy lives in ./aocref-data. Pass
 * `{reference: {constants, datasets: {100: ...}}}` to supply it another way,
 * e.g. in a browser.
 *
 * Usage:
 *   import { parseRec, parseMatch } from "./parse_rec.ts";
 *   const report = parseRec('rec.aoe2record');          // -> report text
 *   const match = parseMatch('rec.aoe2record');         // -> parsed match
 *
 * CLI (mirrors parse_rec.py), from the app/ directory:
 *   node cli/parse_rec.js <recording.aoe2record> [-o out.txt] [--no-chat] [--actions]
 *
 * Not ported: mgz.model.serialize, which parse_rec.py never touches. Only the
 * DE save-68 path is exercised by the recording this was verified against; the
 * older-version branches are ported as written but untested.
 */

/* Node and browser both. Node's fs/zlib/path arrive through runtime, which the
   CLIs populate; the browser passes reference data in as {reference} and
   inflates through parseMatchAsync (DecompressionStream). */
import { runtime } from "./runtime.ts";

/* ------------------------------------------------------------------ */
/* The public surface's types, formerly in parse_rec.d.ts              */
/* ------------------------------------------------------------------ */

export interface ReferenceData {
  constants: unknown;
  /** aocref dataset by id -- 100 for DE, 101 for the AoE1 mod. */
  datasets: Record<number | string, unknown>;
}

export interface ParseRecOptions extends ParseOptions {
  /** Include chat messages in the report. Default: true. */
  chat?: boolean;
  /** Include the full action log. Default: false. */
  actions?: boolean;
}

export interface ParseOptions {
  /** Supply reference data directly instead of reading ./aocref-data. */
  reference?: ReferenceData;
  /** Pre-inflated header, for environments with no synchronous inflate. */
  inflatedHeader?: Uint8Array;
}

/** Bytes, or (Node only) a path to read. */
export type RecordingInput = Uint8Array | ArrayBuffer | string;

/**
 * The parsed match. Shaped by mgz.model -- a Python structure reproduced field
 * for field -- so it stays `any` by design rather than being given a shape
 * nobody has verified. The same goes for the intermediate records below: they
 * are what the byte readers happen to have built at that point, and naming a
 * shape for them would be a guess that the next save version invalidates.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Match = any;

/** Any of the loose mgz-shaped records this file passes around. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = any;

/* ------------------------------------------------------------------ */
/* bytes: the Buffer operations this file needs, on plain Uint8Array   */
/* ------------------------------------------------------------------ */

/* Node's Buffer, declared rather than imported: src/parser must never carry a
   `node:` import, and @types/node is deliberately out of the renderer's
   `types`. Only the one static method used below is described. Guarded by the
   typeof check, exactly as before. */
declare const Buffer: {
  from(buffer: ArrayBufferLike, byteOffset?: number, length?: number): {
    toString(encoding: string): string;
  };
};

const HAS_BUFFER = typeof Buffer !== "undefined";

/** DataView per byte array, cached -- a Stream reuses one for its whole buffer. */
const VIEWS = new WeakMap<Uint8Array, DataView>();
function viewOf(u8: Uint8Array): DataView {
  let view = VIEWS.get(u8);
  if (view === undefined) {
    view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    VIEWS.set(u8, view);
  }
  return view;
}

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(u8: Uint8Array): string {
  let out = "";
  for (const byte of u8) out += byte.toString(16).padStart(2, "0");
  return out;
}

function bytesConcat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A detached copy. Not `.slice()`: on a Node Buffer that returns a view of the
 * same memory, so reversing the copy would corrupt the caller's recording.
 */
function bytesCopy(u8: Uint8Array): Uint8Array {
  return new Uint8Array(u8);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Byte -> code point, so a JS regex can match binary patterns. */
function bytesToLatin1(u8: Uint8Array): string {
  if (HAS_BUFFER) return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("latin1");
  let out = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return out;
}

/** Accept a Uint8Array/ArrayBuffer, or (Node only) a path to read. */
function toBytes(input: RecordingInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof input === "string") {
    if (!runtime.fs) throw new Error("reading by path needs Node; pass the bytes instead");
    return new Uint8Array(runtime.fs.readFileSync(input));
  }
  throw new Error("expected a Uint8Array, ArrayBuffer, or file path");
}

/* ------------------------------------------------------------------ */
/* struct: the sliver of Python's struct module that mgz uses          */
/* ------------------------------------------------------------------ */

class StructError extends Error {}

const CODE_SIZE: Record<string, number> = {
  x: 1, c: 1, b: 1, B: 1, "?": 1,
  h: 2, H: 2,
  i: 4, I: 4, l: 4, L: 4, f: 4,
  q: 8, Q: 8, d: 8,
  s: 1,
};

const FORMAT_CACHE = new Map<string, CompiledFormat>();

interface CompiledFormat {
  little: boolean;
  ops: { code: string; count: number }[];
  size: number;
}

/** Compile a format string into a list of ops plus its total byte size. */
function compileFormat(fmt: string): CompiledFormat {
  const cached = FORMAT_CACHE.get(fmt);
  if (cached) return cached;
  let little = true;
  let i = 0;
  if ("<>=!@".includes(fmt[0])) {
    little = fmt[0] !== ">" && fmt[0] !== "!";
    i = 1;
  }
  const ops: CompiledFormat["ops"] = [];
  let size = 0;
  while (i < fmt.length) {
    let digits = "";
    while (i < fmt.length && fmt[i] >= "0" && fmt[i] <= "9") digits += fmt[i++];
    const code = fmt[i++];
    const count = digits === "" ? 1 : parseInt(digits, 10);
    if (!(code in CODE_SIZE)) throw new StructError(`bad char in struct format: ${code}`);
    ops.push({ code, count });
    size += code === "s" || code === "x" ? count : CODE_SIZE[code] * count;
  }
  const compiled = { little, ops, size };
  FORMAT_CACHE.set(fmt, compiled);
  return compiled;
}

function readScalar(view: DataView, off: number, code: string, little: boolean): number {
  switch (code) {
    case "b": return view.getInt8(off);
    case "B": case "c": case "?": return view.getUint8(off);
    case "h": return view.getInt16(off, little);
    case "H": return view.getUint16(off, little);
    case "i": case "l": return view.getInt32(off, little);
    case "I": case "L": return view.getUint32(off, little);
    case "f": return view.getFloat32(off, little);
    case "d": return view.getFloat64(off, little);
    case "q": return Number(view.getBigInt64(off, little));
    case "Q": return Number(view.getBigUint64(off, little));
    default: throw new StructError(`unsupported code: ${code}`);
  }
}

function calcsize(fmt: string): number {
  return compileFormat(fmt).size;
}

/** struct.unpack_from: read values out of `buf` starting at `offset`. */
function unpackFrom(fmt: string, buf: Uint8Array, offset = 0): Rec[] {
  const { little, ops, size } = compileFormat(fmt);
  if (buf.length - offset < size) {
    throw new StructError(`unpack_from requires a buffer of at least ${size} bytes`);
  }
  const out: Rec[] = [];
  const view = viewOf(buf);
  let pos = offset;
  for (const { code, count } of ops) {
    if (code === "x") {
      pos += count;
    } else if (code === "s") {
      out.push(buf.subarray(pos, pos + count));
      pos += count;
    } else {
      const width = CODE_SIZE[code];
      for (let n = 0; n < count; n++) {
        out.push(readScalar(view, pos, code, little));
        pos += width;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Stream: BytesIO-alike, so the reads below can mirror the Python     */
/* ------------------------------------------------------------------ */

class Stream {
  buf: Uint8Array;
  pos: number;
  _text: string | null;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.pos = 0;
    this._text = null;
  }

  get length() {
    return this.buf.length;
  }

  /** Like BytesIO.read: short at EOF rather than throwing. */
  read(n?: number): Uint8Array {
    const end = n === undefined ? this.buf.length : Math.min(this.pos + n, this.buf.length);
    const out = this.buf.subarray(this.pos, Math.max(end, this.pos));
    this.pos = Math.max(end, this.pos);
    return out;
  }

  seek(offset: number, whence = 0): number {
    if (whence === 0) this.pos = offset;
    else if (whence === 1) this.pos += offset;
    else this.pos = this.buf.length + offset;
    return this.pos;
  }

  tell() {
    return this.pos;
  }

  /** mgz.util.unpack, minus the `shorten` sugar: always returns an array. */
  unpack(fmt: string): Rec[] {
    const size = calcsize(fmt);
    if (this.pos + size > this.buf.length) {
      throw new StructError(`unpack requires a buffer of ${size} bytes`);
    }
    const out = unpackFrom(fmt, this.buf, this.pos);
    this.pos += size;
    return out;
  }

  /**
   * The buffer as a latin-1 string, so byte patterns can be matched with
   * JS regexes (each char code is exactly one byte). Built once, on demand.
   */
  get text() {
    if (this._text === null) this._text = bytesToLatin1(this.buf);
    return this._text;
  }

  /**
   * Offset of `needle` at or after `from`, or -1. Searches the latin-1 view,
   * where the engine's native string search beats a byte loop by a wide margin.
   */
  indexOfBytes(needle: Uint8Array, from = 0): number {
    return this.text.indexOf(bytesToLatin1(needle), from);
  }
}

/* ------------------------------------------------------------------ */
/* Python-compatible number and text formatting                        */
/* ------------------------------------------------------------------ */

/** Python's round(): half away from zero is wrong, it rounds half to even. */
function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python's round(value, digits) for the two-decimal cases mgz uses. */
function pyRoundTo(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

/** Python's str() for a float: always keeps a decimal point. */
function pyFloatStr(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Python's str() for a payload value, as the action log prints it. */
function pyValueStr(value: Rec): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (value instanceof Uint8Array) return `b'${bufferRepr(value)}'`;
  if (Array.isArray(value)) return `[${value.map(pyValueStr).join(", ")}]`;
  if (typeof value === "number" && !Number.isInteger(value)) return String(value);
  return String(value);
}

function bufferRepr(buf: Uint8Array) {
  let out = "";
  for (const byte of buf) {
    if (byte >= 0x20 && byte < 0x7f && byte !== 0x27 && byte !== 0x5c) out += String.fromCharCode(byte);
    else out += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

function padRight(text: string, width: number) {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/* ------------------------------------------------------------------ */
/* Text decoding                                                       */
/* ------------------------------------------------------------------ */

/** Python codec name -> a decoder. Throws on invalid input, like Python. */
function decodeBytes(buf: Uint8Array, encoding: string) {
  const name = String(encoding).toLowerCase();
  if (name === "latin-1" || name === "latin1" || name === "iso-8859-1") {
    // Byte -> code point, i.e. true ISO-8859-1. The WHATWG label of the same
    // name decodes as windows-1252, which differs over 0x80-0x9f.
    return bytesToLatin1(buf);
  }
  if (name === "ascii") {
    for (const byte of buf) {
      if (byte > 0x7f) throw new Error("'ascii' codec can't decode byte");
    }
    return bytesToLatin1(buf);
  }
  const label = { "cp936": "gbk", "gb2312": "gbk", "cp949": "euc-kr", "shift_jis": "shift_jis" }[name] || name;
  return new TextDecoder(label, { fatal: true }).decode(buf);
}

/** bytes.strip(b'\x00') */
function stripNulls(buf: Uint8Array) {
  let start = 0;
  let end = buf.length;
  while (start < end && buf[start] === 0) start++;
  while (end > start && buf[end - 1] === 0) end--;
  return buf.subarray(start, end);
}

/* ------------------------------------------------------------------ */
/* Enumerations (mgz.util.Version, mgz.fast.enums)                     */
/* ------------------------------------------------------------------ */

const Version = {
  AOK: 1, AOC: 4, AOC10: 5, AOC10C: 8,
  USERPATCH12: 12, USERPATCH13: 13, USERPATCH14: 11, USERPATCH15: 20,
  DE: 21, USERPATCH14RC2: 22, MCP: 30, HD: 19,
};
const VERSION_NAMES = Object.fromEntries(Object.entries(Version).map(([k, v]) => [v, k]));

const Operation = { ACTION: 1, SYNC: 2, VIEWLOCK: 3, CHAT: 4, START: 5, POSTGAME: 6, SAVE: 7 };
const OPERATION_NAMES = Object.fromEntries(Object.entries(Operation).map(([k, v]) => [v, k]));

const Action = {
  ERROR: -1, ORDER: 0, STOP: 1, WORK: 2, MOVE: 3, CREATE: 4, ADD_ATTRIBUTE: 5,
  GIVE_ATTRIBUTE: 6, AI_ORDER: 10, RESIGN: 11, SPECTATE: 15, ADD_WAYPOINT: 16,
  STANCE: 18, GUARD: 19, FOLLOW: 20, PATROL: 21, FORMATION: 23, SAVE: 27,
  GROUP_MULTI_WAYPOINTS: 31, CHAPTER: 32, DE_ATTACK_MOVE: 33, HD_UNKNOWN_34: 34,
  DE_RETREAT: 35, DE_UNKNOWN_37: 37, DE_AUTOSCOUT: 38, DE_UNKNOWN_39: 39,
  DE_UNKNOWN_40: 40, DE_TRANSFORM: 41, RATHA_ABILITY: 43, DE_107_A: 44,
  DE_MULTI_GATHERPOINT: 45, DE_UNKNOWN_46: 46, AI_COMMAND: 53, DE_UNKNOWN_80: 80,
  MAKE: 100, RESEARCH: 101, BUILD: 102, GAME: 103, WALL: 105, DELETE: 106,
  ATTACK_GROUND: 107, TRIBUTE: 108, DE_UNKNOWN_109: 109, REPAIR: 110,
  UNGARRISON: 111, MULTIQUEUE: 112, GATE: 114, FLARE: 115, SPECIAL: 117,
  QUEUE: 119, GATHER_POINT: 120, SELL: 122, BUY: 123, DROP_RELIC: 126,
  TOWN_BELL: 127, BACK_TO_WORK: 128, DE_QUEUE: 129, DE_UNKNOWN_130: 130,
  DE_UNKNOWN_131: 131, DE_UNKNOWN_134: 134, DE_UNKNOWN_135: 135,
  DE_UNKNOWN_136: 136, DE_UNKNOWN_137: 137, DE_UNKNOWN_138: 138, DE_107_B: 140,
  DE_UNKNOWN_141: 141, DE_TRIBUTE: 196, POSTGAME: 255,
};
const ACTION_NAMES = Object.fromEntries(Object.entries(Action).map(([k, v]) => [v, k]));

const Postgame = { WORLD_TIME: 1, LEADERBOARDS: 2 };
const Age = { DARK_AGE: 1, FEUDAL_AGE: 2, CASTLE_AGE: 3, IMPERIAL_AGE: 4 };

const Chat = {
  LADDER: 0, VOOBLY: 1, RATING: 2, INJECTED: 3, AGE: 4, SAVE: 5,
  MESSAGE: 6, HELP: 7, DISCARD: 8,
};

/* ------------------------------------------------------------------ */
/* mgz.util helpers                                                    */
/* ------------------------------------------------------------------ */

function getVersion(gameVersion: Rec, saveVersion: Rec, logVersion: Rec) {
  if (gameVersion === "VER 9.3") return Version.AOK;
  if (gameVersion === "VER 9.4") {
    if (logVersion === 3) return Version.AOC10;
    if (logVersion === 5 || saveVersion >= 12.97) return Version.DE;
    if (saveVersion >= 12.36) return Version.HD;
    if (logVersion === 4) return Version.AOC10C;
    return Version.AOC;
  }
  if (gameVersion === "VER 9.8") return Version.USERPATCH12;
  if (gameVersion === "VER 9.9") return Version.USERPATCH13;
  if (gameVersion === "VER 9.A") return Version.USERPATCH14RC2;
  if (["VER 9.B", "VER 9.C", "VER 9.D"].includes(gameVersion)) return Version.USERPATCH14;
  if (["VER 9.E", "VER 9.F"].includes(gameVersion)) return Version.USERPATCH15;
  if (gameVersion === "MCP 9.F") return Version.MCP;
  throw new Error(`unsupported version: ${gameVersion}, ${saveVersion}, ${logVersion}`);
}

function checkFlags(peek: Rec) {
  return peek.every((value: Rec) => value === 0 || value === 1);
}

/* ------------------------------------------------------------------ */
/* mgz.fast.header                                                     */
/* ------------------------------------------------------------------ */

/**
 * mgz uses PLAYER_END as a regex, where the byte after the eight 0xff is a `.`
 * wildcard rather than a literal period -- hence a pattern here, not a Buffer.
 */
const PLAYER_END_LENGTH = 26;
const PLAYER_END_RE = new RegExp(
  "\\xff".repeat(8) + "[\\s\\S]" + "\\x00".repeat(16) + "\\x0b", "g");

/** Absolute offset just past the next PLAYER_END, or -1. `limit` bounds it. */
function findPlayerEnd(text: string, from: number, limit?: number) {
  PLAYER_END_RE.lastIndex = from;
  const match = PLAYER_END_RE.exec(text);
  if (match === null) return -1;
  if (limit !== undefined && match.index + PLAYER_END_LENGTH > limit) return -1;
  return match.index + PLAYER_END_LENGTH;
}
const BLOCK_END = new Uint8Array([0x00, 0x0b]);
const CLASSES = [0x0a, 0x1e, 0x46, 0x50, 0x14];
const SKIP_OBJECTS: [Uint8Array, number][] = [[new Uint8Array([0x1e, 0x00, 0x87, 0x02]), 252]]; // 647: junk DE object

/** One compiled object-search regex per player slot, as _compile_object_search does. */
const OBJECT_REGEXES: RegExp[] = [];
for (let i = 0; i < 9; i++) {
  const classOr = `[${CLASSES.map((c) => `\\x${c.toString(16).padStart(2, "0")}`).join("")}]`;
  const player = `\\x${i.toString(16).padStart(2, "0")}`;
  OBJECT_REGEXES.push(new RegExp(
    `${classOr}${player}(?!\\xff\\xff)(?!\\x00\\x00)[\\x00-\\xff]{4}\\xff\\xff\\xff\\xff[^\\xff]`, "g"));
}
const OBJECT_MATCH_LENGTH = 11; // class + player + 4 + 4 + 1

function aocString(data: Rec) {
  /* Unsigned, though mgz's fast reader signs it: a length is never negative,
     and a scenario's instructions run past 32767 bytes. Signed, such a string
     read as a negative length, `read` returned nothing, and the text was
     swallowed by whatever was parsed next. */
  const [length] = data.unpack("<H");
  return data.read(length);
}

function intPrefixedString(data: Rec) {
  const [length] = data.unpack("<I");
  return data.read(length);
}

function deString(data: Rec) {
  const marker = data.read(2);
  if (marker.length !== 2 || marker[0] !== 0x60 || marker[1] !== 0x0a) {
    throw new Error("de_string marker assertion failed");
  }
  const [length] = data.unpack("<h");
  const [value] = data.unpack(`<${length}s`);
  return value;
}

function hdString(data: Rec) {
  const [length] = data.unpack("<h");
  const marker = data.read(2);
  if (marker.length !== 2 || marker[0] !== 0x60 || marker[1] !== 0x0a) {
    throw new Error("hd_string marker assertion failed");
  }
  const [value] = data.unpack(`<${length}s`);
  return value;
}

function parseObject(buf: Uint8Array, offset: number) {
  const [classId, objectId, instanceId, posX, posY] = unpackFrom("<bxH14xIxff", buf, offset);
  return {
    class_id: classId,
    object_id: objectId,
    instance_id: instanceId,
    position: { x: posX, y: posY },
  };
}

/**
 * Parse a block of objects.
 *
 * PORT: the Python slices the header from the player's start offset and works
 * in relative indices; here `pos` is absolute into the whole header buffer,
 * which is the same arithmetic with a different origin.
 */
function objectBlock(stream: Stream, pos: number, playerNumber: number, index: number): [Rec[], number] {
  const buf = stream.buf;
  const text = stream.text;
  const objects = [];
  let offset = null;
  let end = 0;
  for (;;) {
    if (!offset) {
      const regex = OBJECT_REGEXES[playerNumber];
      regex.lastIndex = pos;
      const match = regex.exec(text);
      end = stream.indexOfBytes(BLOCK_END, pos) - pos + BLOCK_END.length;
      // Python passes endpos=pos+10000 to search(), i.e. the match must fit
      // entirely inside the window.
      if (match === null || match.index + OBJECT_MATCH_LENGTH > pos + 10000) break;
      offset = match.index - pos;
      while (end + 8 < offset) {
        end += stream.indexOfBytes(BLOCK_END, pos + end) - (pos + end) + BLOCK_END.length;
      }
    }
    if (end + 8 === offset) break;
    pos += offset;
    // Speed optimization: skip specified fixed-length objects.
    const test = buf.subarray(pos, pos + 4);
    const skip = SKIP_OBJECTS.some(([fingerprint]) => bytesEqual(test, fingerprint));
    if (!skip) objects.push({ ...parseObject(buf, pos), index });
    offset = null;
    pos += 31;
  }
  return [objects, pos + end];
}

/** Parse Userpatch mod version. */
function parseMod(header: Rec, numPlayers: number, version: Rec) {
  const cur = header.tell();
  const [nameLength] = header.unpack(`<xx${numPlayers}x36x5xh`);
  const [resources] = header.unpack(`<${nameLength + 1}xIx`);
  const values = header.unpack(`<${resources}f`);
  header.seek(cur);
  if (version === Version.USERPATCH15) {
    const number = Math.trunc(values[198]);
    return [Math.floor(number / 1000), String(number % 1000).split("").join(".")];
  }
  return null;
}

/** Parse a player (and objects). */
function parsePlayer(header: Rec, playerNumber: number, numPlayers: number, save: Rec) {
  let rep = 9;
  if (save >= 61.5) rep = numPlayers;
  const head = header.unpack(`<bx${numPlayers}x${rep}i5xh`);
  const type = head[0];
  const diplomacy = head.slice(1, 1 + rep);
  const nameLength = head[head.length - 1];
  const [name, resources] = header.unpack(`<${nameLength - 1}s2xIx`);
  const resourcesLen = save >= 63 ? 8 : 4;
  header.read(resources * resourcesLen);
  const [startX, startY, civilizationId, colorId] = header.unpack("<xff9xb3xbx");
  const offset = header.tell();
  // Skips thousands of bytes that are not easy to parse.
  const objectStart = /\x0b\x00[\s\S]\x00\x00\x00\x02\x00\x00/g;
  objectStart.lastIndex = offset;
  const startMatch = objectStart.exec(header.text);
  if (!startMatch) throw new Error("could not find object start");
  const start = startMatch.index + startMatch[0].length;
  let [objects, end] = objectBlock(header, start, playerNumber, 0);
  let sleeping;
  let doppel;
  [sleeping, end] = objectBlock(header, end, playerNumber, 1);
  [doppel, end] = objectBlock(header, end, playerNumber, 2);
  if (bytesEqual(header.buf.subarray(end + 8, end + 10), BLOCK_END)) end += 10;
  if (bytesEqual(header.buf.subarray(end, end + 2), BLOCK_END)) end += 2;
  header.seek(end);
  let device = 0;
  if (save >= 37) {
    const windowStart = header.tell();
    const data = header.read(100);
    device = data[8];
    // Jump to the end of player data.
    let playerEnd = findPlayerEnd(header.text, windowStart, windowStart + 100);
    if (playerEnd === -1) {
      // Normally this is 26 bytes in, but where object parsing failed it can be
      // tens of thousands of bytes away, so search the whole remainder.
      const base = header.tell();
      header.read();
      playerEnd = findPlayerEnd(header.text, base);
      if (playerEnd === -1 && playerNumber < numPlayers - 1) {
        // Happens on restored games; only fatal if this is not the last player,
        // since we seek to the next block anyway.
        throw new Error("could not find player end");
      }
    }
    if (playerEnd !== -1) header.seek(playerEnd);
  }
  return [
    {
      number: playerNumber,
      type,
      name,
      diplomacy,
      civilization_id: civilizationId,
      color_id: colorId,
      objects: objects.concat(sleeping, doppel),
      position: { x: startX, y: startY },
    },
    device,
  ];
}

function parseLobby(data: Rec, version: Rec, save: Rec) {
  if (version === Version.DE) {
    data.read(5);
    if (save >= 20.06) data.read(9);
    if (save >= 26.16) data.read(5);
    if (save >= 37) data.read(8);
    if (save >= 64.3) data.read(16);
    if (save >= 66.3) data.read(1);
  }
  data.read(8);
  if (version !== Version.DE && version !== Version.HD) data.read(1);
  const [revealMapId, mapSize, population, gameTypeId, lockTeams] = data.unpack("I4xIIbb");
  if (version === Version.DE || version === Version.HD) {
    data.read(5);
    if (save >= 13.13) data.read(4);
    if (save >= 25.22) data.read(1);
  }
  const chat = [];
  const [messageCount] = data.unpack("<I");
  for (let i = 0; i < messageCount; i++) {
    const [length] = data.unpack("<I");
    const message = stripNulls(data.read(length));
    if (message.length > 0) chat.push(message);
  }
  let seed = null;
  if (version === Version.DE) [seed] = data.unpack("<i");
  return {
    reveal_map_id: revealMapId,
    map_size: mapSize,
    population: population * (version !== Version.DE && version !== Version.HD ? 25 : 1),
    game_type_id: gameTypeId,
    lock_teams: lockTeams === 1,
    chat,
    seed,
  };
}

function parseMap(data: Rec, version: Rec, save: Rec) {
  let tileFormat = "<xbbx";
  if (version === Version.DE) {
    tileFormat = "<bxb6x";
    if (save >= 62.0) tileFormat = "<bxxb6x";
    data.read(8);
  }
  const [sizeX, sizeY, zoneNum] = data.unpack("<III");
  const tileNum = sizeX * sizeY;
  for (let i = 0; i < zoneNum; i++) {
    if (version === Version.DE || version === Version.HD) data.read(2048 + tileNum * 2);
    else data.read(1275 + tileNum);
    const [numFloats] = data.unpack("<I");
    data.read(numFloats * 4);
    data.read(4);
  }
  const [allVisible] = data.unpack("<bx");
  const tiles = [];
  for (let i = 0; i < tileNum; i++) tiles.push(data.unpack(tileFormat));
  const [numData] = data.unpack("<I4x");
  data.read(numData * 4);
  for (let i = 0; i < numData; i++) {
    const [numObs] = data.unpack("<I");
    data.read(numObs * 8);
  }
  const [x2, y2] = data.unpack("<II");
  data.read(x2 * y2 * 4);
  if (save >= 61.5) data.read(x2 * y2 * 4);
  const [restoreTime] = data.unpack("<I");
  return {
    all_visible: allVisible === 1,
    restore_time: restoreTime,
    dimension: sizeX,
    tiles,
  };
}

/**
 * One trigger of a DE scenario, skipped rather than kept.
 *
 * Nothing here is reported -- the only reason to walk a trigger is to arrive
 * at the byte after it, because the lobby block (map size, population, game
 * type, chat, seed) sits past the last one. mgz walks a much older shape and
 * gives up on anything a campaign mission contains, which is why a scenario
 * game used to end the header parse rather than finish it.
 *
 * The shape, worked out from the recordings in the development folder and
 * checked by the header ending exactly 24 bytes past the lobby on all 66 of
 * them: a 27-byte record, three strings, then the effects and the conditions.
 * An effect and a condition both begin with their type and a field count, and
 * that count is the whole of their size -- `(2 + count)` int32s -- so neither
 * needs a table of versions. What follows differs: an effect carries its
 * message and sound, then the ids of the objects it was pointed at (field 6
 * counts them, -1 for none), then eight bytes; a condition carries an
 * xs_function string. Each list is followed by its own display order.
 */
function deTrigger(data: Rec) {
  data.read(27);
  intPrefixedString(data); // description
  intPrefixedString(data); // name
  intPrefixedString(data); // short description
  const [nEffects] = data.unpack("<I");
  for (let e = 0; e < nEffects; e++) {
    data.read(4); // effect type
    const [fields] = data.unpack("<I");
    const body = data.read(fields * 4);
    // Field 6 counts the objects the effect was pointed at; -1 where it was
    // pointed at none. The first two fields are already read, so it is the
    // fifth int32 of what is left.
    const [selected] = fields >= 5 ? unpackFrom("<i", body, 16) : [-1];
    intPrefixedString(data); // message
    intPrefixedString(data); // sound
    if (selected > 0) data.read(selected * 4);
    data.read(8);
  }
  data.read(nEffects * 4); // effect display order
  const [nConditions] = data.unpack("<I");
  for (let c = 0; c < nConditions; c++) {
    data.read(4); // condition type
    const [fields] = data.unpack("<I");
    data.read(fields * 4);
    intPrefixedString(data); // xs_function
  }
  data.read(nConditions * 4); // condition display order
}

function parseScenario(data: Rec, _numPlayers: number, version: Rec, save: Rec) {
  let campaignFilename = new Uint8Array(0);
  data.unpack("<f"); // scenario_version
  data.read(4);
  if (save >= 61.5) {
    data.read(4);
    if (save < 66.6) data.read(4);
  }
  data.read(16 * 256);
  data.read(16 * 4);
  if (save >= 66.6) {
    for (let i = 0; i < 16; i++) {
      data.read(8);
      deString(data);
      deString(data);
      data.read(4);
    }
  }
  if (save >= 61.5 && save < 66.6) data.read(64);
  if (save < 66.6) {
    for (let i = 0; i < 16; i++) {
      data.read(12);
      if (save >= 13.34) data.read(4);
      data.read(4);
    }
  }
  /* The two 64-byte blocks mgz reads *after* the scenario filename are in
     front of it, before the padding and the elapsed time. Everything in them
     is zero and every lobby game has an empty filename, so reading them on
     the far side lands in the same place and the mistake never showed. A
     campaign mission names its file ("2_Joan_6.aoe2scenario"), and then the
     whole of the rest of the scenario -- instructions, the strings after it,
     the trigger block -- is read from the wrong offset. */
  if (save >= 67.2) data.read(128);
  data.read(5);
  data.unpack("<f"); // elapsed_time
  const scenarioFilename = aocString(data);
  if (save >= 67.2) {
    data.read(24); // instruction, hints, victory, defeat, history, scouts ids
  } else {
    if (version === Version.DE) data.read(64);
    /* Same filename, on the other side of the move. Before 67.2 it sits 62
       bytes into the block 66.6 added, and mgz pads straight over it -- which
       works only while it is empty, as it is in every lobby game. A campaign
       names it, and its length then shifts the message ids and every string
       after them. The flat 68 is 62 + the empty string's own 2 + 4, so this
       reads the same bytes for a skirmish and the right ones for a campaign.
       No recording here is below 67.2, so this branch is reasoned, not
       tested. */
    if (save >= 66.6) {
      data.read(62);
      campaignFilename = aocString(data);
      data.read(4); // the sixth message id, which the twenty below predates
    }
    data.read(20);
  }
  const instructions = aocString(data);
  for (let i = 0; i < 9; i++) aocString(data);
  data.read(78);
  for (let i = 0; i < 16; i++) aocString(data);
  data.read(196);
  for (let i = 0; i < 16; i++) {
    data.read(24);
    if (version === Version.DE || version === Version.HD) data.read(4);
  }
  data.read(12672);
  if (version === Version.DE) data.read(196);
  else for (let i = 0; i < 16; i++) data.read(332);
  if (version === Version.HD) data.read(644);
  data.read(88);
  if (version === Version.HD) data.read(16);
  const [mapId, difficultyId] = data.unpack("<II");
  const remainderStart = data.tell();
  data.read(); // the Python reads the rest and searches it; we search in place
  let end;
  // find, relative to remainderStart, mirroring bytes.find()'s -1
  const findFrom = (needle: Uint8Array) => {
    const at = data.indexOfBytes(needle, remainderStart);
    return at === -1 ? -1 : at - remainderStart;
  };
  if (version === Version.DE) {
    let settingsVersion;
    /* mgz's table stops at 4.5. The two save versions after it moved the
       marker again -- 67.2 to 4.7, 68 to 4.9 -- and without them the search
       below finds nothing, `end` comes out as -1 + 8 = 7, and the cursor
       lands seven bytes past the map id rather than at the trigger block.
       A random-map game survives that by luck (the zeros there read as "no
       triggers") but everything the lobby block holds -- map size, population,
       game type, chat, seed -- was being read out of the middle of the
       scenario. Both values are measured, from every recording in the
       development folder; where 4.7 begins below 67.2 is not known. */
    if (save >= 68) settingsVersion = 4.9;
    else if (save >= 67.2) settingsVersion = 4.7;
    else if (save >= 66.3) settingsVersion = 4.5;
    else if (save >= 64.3) settingsVersion = 4.1;
    else if (save >= 63) settingsVersion = 3.9;
    else if (save >= 61.5) settingsVersion = 3.6;
    else if (save >= 37) settingsVersion = 3.5;
    else if (save >= 26.21) settingsVersion = 3.2;
    else if (save >= 26.16) settingsVersion = 3.0;
    else if (save >= 25.22) settingsVersion = 2.6;
    else if (save >= 25.06) settingsVersion = 2.5;
    else if (save >= 13.34) settingsVersion = 2.4;
    else settingsVersion = 2.2;
    const needle = new Uint8Array(8);
    new DataView(needle.buffer).setFloat64(0, settingsVersion, true);
    end = findFrom(needle) + 8;
  } else {
    end = findFrom(bytesFromHex("9a9999999999f93f")) + 13;
  }
  data.seek(remainderStart + end);

  if (version === Version.DE) {
    data.read(1);
    const [nTriggers] = data.unpack("<I");
    for (let i = 0; i < nTriggers; i++) {
      if (save >= 67.2) deTrigger(data);
      else {
        data.read(22);
        data.read(4);
        intPrefixedString(data); // description
        intPrefixedString(data); // name
        intPrefixedString(data); // short description
        const [nEffects] = data.unpack("<I");
        for (let e = 0; e < nEffects; e++) {
          data.read(216);
          intPrefixedString(data); // text
          intPrefixedString(data); // sound
        }
        data.read(nEffects * 4);
        const [nCondition] = data.unpack("<I");
        data.read(nCondition * 125);
      }
    }
    data.unpack(`<${nTriggers}I`); // trigger_list_order
    if (save >= 67.2) {
      /* mgz's 1032 is 1028 of default plus a variable count that is zero in
         every lobby game -- a scenario names its variables here, and each
         name costs the reader its bytes. */
      data.read(1028);
      const [nVariables] = data.unpack("<I");
      for (let v = 0; v < nVariables; v++) {
        data.read(4); // variable id
        intPrefixedString(data); // name
      }
    } else {
      data.read(1032); // default!
    }
  }

  return {
    map_id: mapId,
    difficulty_id: difficultyId,
    instructions,
    // Only one of the two is ever set: 67.2 and up read the name in front of
    // the padding, below that it comes out of the block after it.
    scenario_filename: scenarioFilename.length ? scenarioFilename : campaignFilename,
  };
}

/** Parse DE header string block. */
function stringBlock(data: Rec) {
  const strings = [];
  for (;;) {
    const [crc] = data.unpack("<I");
    if (crc > 0 && crc < 255) break;
    strings.push(decodeBytes(deString(data), "utf-8").split(":"));
  }
  return strings;
}

/**
 * Parse DE-specific header.
 *
 * PORT: includes mgz_patch.py's save-68 fix -- that save version appended a
 * trailing de_string to every player record -- plus a second save-68
 * correction of its own at the end of the block (see the comment there).
 */
function parseDe(data: Rec, version: Rec, save: Rec, skip = false) {
  if (version !== Version.DE) return null;
  let build = null;
  if (save >= 25.22 && !skip) [build] = data.unpack("<I");
  let timestamp = null;
  if (save >= 26.16 && !skip) [timestamp] = data.unpack("<I"); // missing on console (?)
  data.read(12);
  const dlcIds = [];
  const [dlcCount] = data.unpack("<I");
  for (let i = 0; i < dlcCount; i++) dlcIds.push(data.unpack("<I")[0]);
  data.read(4);
  let difficultyId;
  if (save >= 61.5) data.unpack("<I"); // map_dimension
  else [difficultyId] = data.unpack("<I");
  data.read(4);
  const [rmsMapId] = data.unpack("<I");
  data.read(4);
  const [victoryTypeId] = data.unpack("<I");
  const [startingResourcesId] = data.unpack("<I");
  const [startingAgeId] = data.unpack("<I");
  const [endingAgeId] = data.unpack("<I");
  data.read(12);
  const [speed] = data.unpack("<f");
  const [treatyLength] = data.unpack("<I");
  const [populationLimit] = data.unpack("<I");
  const [numPlayers] = data.unpack("<I");
  data.read(14);
  // mgz calls this difficulty, but mgz/header/de.py names the byte at this
  // offset team_bonus_disabled -- it is 0 in every game seen, which is why DE
  // recordings all report "Hardest". Kept for parity; the difficulty actually
  // reported comes from the instructions block (see instructionsSetting).
  if (save >= 61.5) [difficultyId] = data.unpack("<B");
  const [randomPositions, allTechnologies] = data.unpack("<bb");
  data.read(1);
  const [lockTeams] = data.unpack("<b");
  const [lockSpeed] = data.unpack("<b");
  const [multiplayer] = data.unpack("<b");
  const [cheats] = data.unpack("<b");
  const [recordGame] = data.unpack("<b");
  const [animalsEnabled] = data.unpack("<b");
  const [predatorsEnabled] = data.unpack("<b");
  const [turboEnabled] = data.unpack("<b");
  const [sharedExploration] = data.unpack("<b");
  const [teamPositions] = data.unpack("<b");
  data.read(12);
  if (save >= 25.06) data.read(1);
  if (save > 50) data.read(1);
  const players = [];
  const slots = save < 66.3 && save >= 37 ? numPlayers : 8;
  for (let i = 0; i < slots; i++) {
    data.read(4);
    const [colorId] = data.unpack("<i");
    data.read(2);
    const [teamId] = data.unpack("<b");
    data.read(9);
    const [civilizationId] = data.unpack("<I");
    let customCivSelection = null;
    if (save >= 61.5) {
      const [customCivCount] = data.unpack("<I");
      if (save >= 63.0 && customCivCount > 0) {
        customCivSelection = [];
        for (let c = 0; c < customCivCount; c++) customCivSelection.push(data.unpack("<I")[0]);
      }
    }
    deString(data);
    data.read(1);
    const aiName = deString(data);
    let censoredName = null;
    if (save >= 66.3) censoredName = deString(data);
    const name = deString(data);
    const [type] = data.unpack("<I");
    const [profileId, number] = data.unpack("<I4xi");
    if (save < 25.22) data.read(8);
    const [preferRandom] = data.unpack("b");
    data.read(1);
    let handicap = 100;
    if (save >= 25.06) {
      const handicapData = data.read(8);
      handicap = unpackFrom("<I", handicapData, 4)[0];
    }
    if (save >= 64.3) data.read(4);
    /* mgz_patch.py calls this new in save 68; 67.2 carries it too, and
       without it every player record after the first is read four bytes
       early. Where below 67.2 it starts is not known. */
    if (save >= 67.2) deString(data);

    players.push({
      number,
      color_id: colorId,
      team_id: teamId,
      ai_name: aiName,
      name,
      censored_name: save >= 66.3 ? censoredName : name,
      type,
      profile_id: profileId,
      civilization_id: civilizationId,
      custom_civ_selection: customCivSelection,
      prefer_random: preferRandom === 1,
      handicap,
    });
  }
  data.read(12);
  if (save < 66.3 && save >= 37) {
    for (let i = 0; i < 8 - numPlayers; i++) {
      if (save >= 61.5) data.read(4);
      data.read(12);
      deString(data);
      data.read(1);
      deString(data);
      deString(data);
      data.read(38);
      if (save >= 64.3) data.read(4);
    }
  }
  data.read(4);
  const [rated] = data.unpack("b");
  const [allowSpecs] = data.unpack("b");
  const [visibility] = data.unpack("<I");
  const [hiddenCivs] = data.unpack("b");
  data.read(1);
  const [specDelay] = data.unpack("<I");
  data.read(1);
  let strings = stringBlock(data);
  data.read(8);
  for (let i = 0; i < 20; i++) strings = strings.concat(stringBlock(data));
  data.read(4);
  if (save < 25.22) data.read(236);
  if (save >= 25.22) {
    data.seek(-4, 1);
    const [l] = data.unpack("<I");
    data.read(l * 4);
  }
  const [blocks] = data.unpack("<Q");
  for (let i = 0; i < blocks; i++) {
    data.read(4);
    deString(data);
    data.read(4);
  }
  if (save >= 25.02) data.read(8);
  const guid = bytesCopy(data.read(16));
  const lobby = deString(data);
  if (save >= 25.22) data.read(8);
  const mod = deString(data);
  /* mgz reads 33 fixed bytes here (19 + 5 + 9). The last of those groups is
     not fixed: 3 bytes, a de_string, then 2. The string is empty in a lobby
     game, which is why a fixed 33 works at all -- but a single-player game
     names its scenario there ("cam2"), and every byte after it is then read
     one string too early. That is the whole of the `de_string marker
     assertion failed` on 93 of the 131 recordings in the development folder. */
  data.read(27);
  deString(data); // the scenario name; read to move the cursor past it
  data.read(2);
  if (save >= 20.06) data.read(1);
  if (save >= 20.16) data.read(8);
  if (save >= 25.06) data.read(21);
  if (save >= 25.22) data.read(4);
  if (save >= 26.16) data.read(8);
  if (save >= 37) data.read(3);
  if (save > 50) data.read(8);
  if (save >= 61.5) data.read(1);
  if (save >= 63) data.read(5);
  if (save >= 66.3) {
    const [c] = data.unpack("<I");
    data.read(12);
    data.read(c * 4);
  }
  if (!skip) {
    deString(data);
    data.read(8);
    // Save 68 inserted two int32s ahead of the timestamp. mgz (and so
    // mgz_patch.py) still reads the first of them as the timestamp, which
    // leaves the header cursor 8 bytes short of the ai block: parseMetadata
    // then reads the timestamp as ai, decides every game has an AI database,
    // and hunts for its 4096-zero terminator. Games that really do have an AI
    // survive that by luck -- the search still lands on the right run -- but a
    // human-only multiplayer game has no such run ahead of it, so the seek
    // lands in the middle of nothing and the whole header parse collapses.
    if (save >= 68) data.read(8);
    if (save >= 37) [timestamp] = data.unpack("<II");
  }
  let rmsModId = null;
  let rmsFilename = null;
  for (const s of strings) {
    if (s[0] === "SUBSCRIBEDMODS" && s[1] === "RANDOM_MAPS") {
      rmsModId = s[3].split("_")[0];
      rmsFilename = s[2];
    }
  }
  return {
    players,
    guid: formatUuid(guid),
    lobby: decodeBytes(lobby, "utf-8"),
    mod: decodeBytes(mod, "utf-8"),
    difficulty_id: difficultyId,
    victory_type_id: victoryTypeId,
    starting_resources_id: startingResourcesId,
    starting_age_id: startingAgeId > 0 ? startingAgeId - 2 : 0,
    ending_age_id: endingAgeId > 0 ? endingAgeId - 2 : 0,
    speed,
    population_limit: populationLimit,
    treaty_length: treatyLength,
    team_together: !randomPositions,
    all_technologies: Boolean(allTechnologies),
    lock_teams: Boolean(lockTeams),
    lock_speed: Boolean(lockSpeed),
    multiplayer: Boolean(multiplayer),
    cheats: Boolean(cheats),
    record_game: Boolean(recordGame),
    animals_enabled: Boolean(animalsEnabled),
    predators_enabled: Boolean(predatorsEnabled),
    turbo_enabled: Boolean(turboEnabled),
    shared_exploration: Boolean(sharedExploration),
    team_positions: Boolean(teamPositions),
    build,
    timestamp,
    spec_delay: specDelay,
    rated: rated === 1,
    allow_specs: Boolean(allowSpecs),
    hidden_civs: Boolean(hiddenCivs),
    visibility_id: visibility,
    rms_mod_id: rmsModId,
    rms_map_id: rmsMapId,
    rms_filename: rmsFilename,
    dlc_ids: dlcIds,
  };
}

function formatUuid(buf: Uint8Array) {
  const hex = bytesToHex(buf);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseHd(data: Rec, version: Rec, save: Rec) {
  if (version !== Version.HD || save <= 12.34) return null;
  data.read(12);
  const [dlcCount] = data.unpack("<I");
  data.read(dlcCount * 4);
  data.read(4);
  const [difficultyId, mapId] = data.unpack("<II");
  data.read(80);
  const players = [];
  for (let i = 0; i < 8; i++) {
    data.read(4);
    const [colorId] = data.unpack("<i");
    data.read(12);
    const [civilizationId] = data.unpack("<I");
    hdString(data);
    data.read(1);
    hdString(data);
    const name = hdString(data);
    data.read(4);
    const [steamId, number] = data.unpack("<Qi");
    data.read(8);
    if (name.length) {
      players.push({
        number,
        color_id: colorId,
        name,
        profile_id: steamId,
        civilization_id: civilizationId,
      });
    }
  }
  data.read(26);
  hdString(data);
  data.read(8);
  hdString(data);
  data.read(8);
  hdString(data);
  data.read(8);
  const guid = bytesCopy(data.read(16));
  const lobby = hdString(data);
  const mod = hdString(data);
  data.read(8);
  hdString(data);
  data.read(4);
  return {
    players,
    guid: formatUuid(guid),
    lobby: decodeBytes(lobby, "utf-8"),
    mod: decodeBytes(mod, "utf-8"),
    map_id: mapId,
    difficulty_id: difficultyId,
  };
}

function decompress(data: Rec, options: Rec) {
  const prefixSize = 8;
  const [headerLen] = data.unpack("<II");
  const zlibHeader = data.read(headerLen - prefixSize);
  // The browser has no synchronous inflate, so parseMatchAsync inflates the
  // header up front and hands it over here.
  if (options && options.inflatedHeader) return new Stream(toBytes(options.inflatedHeader));
  if (!runtime.zlib) {
    throw new Error("no synchronous inflate available: use parseMatchAsync()");
  }
  return new Stream(new Uint8Array(runtime.zlib.inflateRawSync(zlibHeader)));
}

/** Byte range of the zlib-compressed header inside a recording. */
function headerRange(bytes: Uint8Array) {
  const [headerLen] = unpackFrom("<I", bytes, 0);
  return [8, headerLen];
}

/** Raw-deflate inflate: zlib in Node, DecompressionStream in the browser. */
async function inflateRaw(compressed: Uint8Array) {
  if (runtime.zlib) return new Uint8Array(runtime.zlib.inflateRawSync(compressed));
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this environment has no DecompressionStream");
  }
  const stream = new Blob([compressed as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    // A stream error here surfaces as an opaque "Failed to fetch", and the
    // usual cause is simply that this file is not a recording.
    throw new Error("header did not decompress -- is this an .aoe2record file?");
  }
}

function parseVersion(header: Rec, data: Rec) {
  const [log] = data.unpack("<I");
  let [game, save] = header.unpack("<7sxf");
  if (save === -1) {
    [save] = header.unpack("<I");
    if (save !== 37) save /= 1 << 16;
  }
  const gameName = decodeBytes(game, "ascii");
  const version = getVersion(gameName, pyRoundTo(save, 2), log);
  return [version, gameName, pyRoundTo(save, 2), log];
}

function parsePlayers(header: Rec, numPlayers: number, version: Rec, save: Rec) {
  let cur = header.tell();
  const gaia = version === Version.DE || version === Version.HD ? "Gaia" : "GAIA";
  const needle = bytesConcat([
    new Uint8Array([0x05, 0x00]),
    Uint8Array.from(gaia, (c) => c.charCodeAt(0)),
    new Uint8Array([0x00]),
  ]);
  const found = header.indexOfBytes(needle, cur);
  const anchor = found === -1 ? -1 : found - cur;
  let rev = 43;
  if (save >= 61.5) rev = 7 + numPlayers * 4;
  header.seek(cur + anchor - numPlayers - rev);
  const mod = parseMod(header, numPlayers, version);
  const players = [];
  for (let number = 0; number < numPlayers; number++) {
    players.push(parsePlayer(header, number, numPlayers, save));
  }
  cur = header.tell();
  const pv = save >= 61.5
    ? new Uint8Array([0x66, 0x66, 0x06, 0x40])
    : new Uint8Array([0x00, 0x00, 0x00, 0x40]);
  const pvFound = header.indexOfBytes(pv, cur);
  const pointsVersion = pvFound === -1 ? -1 : pvFound - cur;
  header.seek(cur);
  header.read(pointsVersion);
  for (let i = 0; i < numPlayers; i++) {
    header.unpack("<f"); // version
    const [entries] = header.unpack("<i");
    header.read(5 + entries * 44);
    const [points] = header.unpack("<i");
    header.read(8 + points * 32);
  }
  return [players.map((p) => p[0]), mod, players[0][1]];
}

function parseMetadata(header: Rec, save: Rec, skipAi = true) {
  const [ai] = header.unpack("<I");
  if (ai > 0) {
    if (!skipAi) throw new Error("don't know how to parse ai");
    const offset = header.tell();
    header.read();
    // Jump to the end of ai data.
    const aiEnd = header.indexOfBytes(new Uint8Array(4096), offset);
    if (aiEnd === -1) throw new Error("could not find ai end");
    header.seek(aiEnd + 4096);
  }
  const [gameSpeed, ownerId, numPlayers, cheats] = header.unpack("<24xf17xhbxb");
  if (save < 61.5) header.read(60);
  else header.read(24 + numPlayers * 4);
  return [{ speed: gameSpeed, owner_id: ownerId, cheats: cheats === 1 }, numPlayers];
}

/** Parse recorded game header (mgz.fast.header.parse). */
function parseHeader(data: Rec, options: ParseOptions): Rec {
  let out;
  try {
    const header = decompress(data, options);
    const [version, game, save, log] = parseVersion(header, data);
    if (![Version.USERPATCH15, Version.DE, Version.HD].includes(version)) {
      throw new Error(`${VERSION_NAMES[version]} not supported`);
    }
    const de = parseDe(header, version, save);
    const hd = parseHd(header, version, save);
    const [metadata, numPlayers] = parseMetadata(header, save);
    const map = parseMap(header, version, save);
    const [players, mod, device] = parsePlayers(header, numPlayers, version, save);
    const scenario = parseScenario(header, numPlayers, version, save);
    const lobby = parseLobby(header, version, save);
    out = {
      version,
      game_version: game,
      save_version: save,
      log_version: log,
      players,
      map,
      de,
      hd,
      mod: de ? de.dlc_ids : mod,
      metadata,
      scenario,
      lobby,
      device,
    };
  } catch (err) {
    if (err instanceof StructError || err instanceof RangeError) {
      throw new Error(`could not parse: ${(err as Error).message}`);
    }
    throw err;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* mgz.fast.actions -- action bodies for DE >= 71094                   */
/* ------------------------------------------------------------------ */

function parseAction71094(actionType: Rec, playerId: number, raw: Rec) {
  const data = new Stream(raw);
  let payload: Rec = {};
  if (actionType === Action.RESIGN) {
    data.unpack("<b");
  }
  if (actionType === Action.RESEARCH) {
    // PORT: mgz_patch.py's fix. A RESEARCH body is 13 bytes, optionally
    // followed by `selected` object ids -- an AI's command stops at 13, so
    // reading the list unconditionally (as mgz does) turns every AI research
    // into Action.ERROR. The trailing ids are unused downstream, so skip them.
    const [objectId, , technologyId] = data.unpack("<Ihh5x");
    payload = { technology_id: technologyId, object_ids: [objectId] };
  }
  if (actionType === Action.GAME) {
    const [commandId] = data.unpack("<h");
    payload = { command_id: commandId };
    if (commandId === 0) {
      const [, targetPlayer, , mode] = data.unpack("<2xhhfb");
      payload.target_player_id = targetPlayer;
      payload.diplomacy_mode = mode;
    } else if (commandId === 1) {
      payload.speed = data.unpack("<6xf")[0];
    } else if ([13, 14, 17, 18].includes(commandId)) {
      payload.number = data.unpack("<4xh")[0];
    }
  }
  if (actionType === Action.DE_QUEUE) {
    const [selected, , unitId, amount] = data.unpack("<h4xhhh4x");
    const objectIds = data.unpack(`<${selected}I`);
    payload = { object_ids: objectIds, amount, unit_id: unitId };
  }
  if (actionType === Action.MOVE) {
    const [x, y, selected] = data.unpack("<4x2fh");
    let objectIds = [];
    data.read(6);
    if (selected > 0) objectIds = data.unpack(`<${selected}I`);
    payload = { object_ids: objectIds, x, y };
  }
  if (actionType === Action.ORDER) {
    const [targetId, x, y, selected] = data.unpack("<I2fh");
    let objectIds = [];
    data.read(6);
    if (selected > 0) objectIds = data.unpack(`<${selected}I`);
    payload = { object_ids: objectIds, target_id: targetId, x, y };
  }
  if (actionType === Action.BUILD) {
    const [selected, x, y, buildingId] = data.unpack("<h2xffI8xhbb");
    const objectIds = data.unpack(`${selected}I`);
    payload = { building_id: buildingId, object_ids: objectIds, x, y };
  }
  if (actionType === Action.GATHER_POINT) {
    const [selected, x, y, targetId, targetType] = data.unpack("<h2xffiix");
    const objectIds = data.unpack(`${selected}I`);
    payload = { target_id: targetId, target_type: targetType, x, y, object_ids: objectIds };
  }
  if (actionType === Action.DE_MULTI_GATHERPOINT) {
    // A best guess: there is other unknown data in the payload.
    const [targetId, x, y] = data.unpack("<iff");
    payload = { target_id: targetId, x, y };
  }
  if (actionType === Action.STANCE) {
    const [selected, stanceId] = data.unpack("<II");
    const objectIds = data.unpack(`${selected}I`);
    payload = { stance_id: stanceId, object_ids: objectIds };
  }
  if (actionType === Action.SPECIAL) {
    const [selected, targetId, x, y, slotId, orderId] = data.unpack("<Iiff4xh2xh2x");
    const objectIds = data.unpack(`${selected}I`);
    payload = { order_id: orderId, slot_id: slotId, target_id: targetId, x, y, object_ids: objectIds };
  }
  if (actionType === Action.FORMATION) {
    const [selected, formationId] = data.unpack("<II");
    const objectIds = data.unpack(`${selected}I`);
    payload = { formation_id: formationId, object_ids: objectIds };
  }
  if (actionType === Action.BUY || actionType === Action.SELL) {
    const [resourceId, amount, objectId] = data.unpack("<hhI");
    payload = { resource_id: resourceId, amount, object_ids: [objectId] };
  }
  if (actionType === Action.DE_TRANSFORM) {
    // autoscout enable?
    const [objectId] = data.unpack("<II");
    payload = { object_ids: [objectId] };
  }
  if (actionType === Action.AI_ORDER) {
    // used for autoscout moves
    //
    // DEVIATION FROM MGZ: mgz reads '<II4xIff', which is misaligned. The body
    // is seven words and mgz skips the wrong one -- offset 12 is 0 in all 3,991
    // AI_ORDERs across both recordings in .data, while the fields it passes
    // over or misreads are the whole of what an AI army is doing:
    //
    //   offset  0  a             1 here in every sample
    //   offset  4  object_id     the unit being ordered
    //   offset  8  target_id     the object acted on, -1 for none  (mgz skips)
    //   offset 12  always 0                                        (mgz reads)
    //   offset 16  order_type    700 attack; 702/718 own-object; 705/706/707/
    //                            710/724 move-like, never carry a target
    //   offset 20  x             (mgz reads this as y)
    //   offset 24  y             (mgz never reads it)
    //
    // So mgz's x is order_type reinterpreted as a float -- a denormal near
    // 9.9e-43, positive, so enrichAction accepts it and every AI_ORDER gets a
    // position pinned to x=0. Its y is really the x. Both are corrected here.
    //
    // Every enemy-owned target in both recordings sits under order_type 700,
    // which makes `AI_ORDER where order_type === 700` the AI's attack log.
    //
    // None of this reaches a CLI output: positions are not printed, and the
    // action log filters to INTERESTING_PAYLOAD_KEYS. Parity holds either way
    // -- python/ and web/ still carry mgz's version.
    const [, objectId, targetId, , orderType, x, y] = data.unpack("<IIIIIff");
    payload = { object_ids: [objectId], x, y, target_id: targetId, order_type: orderType };
  }
  if (actionType === Action.WORK || actionType === Action.DE_RETREAT) {
    // DEVIATION FROM MGZ: mgz has no branch for either, so both arrive as a
    // bare {player_id} -- and WORK is the largest action type in the file at
    // 75,171 of the 93k in .data/rec.aoe2record, the whole of what the AI tells
    // its units to do.
    //
    // The old construct parser's `ai_interact` layout still fits, minus the
    // 3-byte header parseAction has already stripped: target, position,
    // selection count, one always-1 word, then the ids. WORK is fixed at 24
    // bytes (always exactly one unit); DE_RETREAT carries a real selection.
    const [targetId, x, y, selected] = data.unpack("<IffI4x");
    const objectIds = selected < 255 ? data.unpack(`<${selected}I`) : [];
    payload = { object_ids: objectIds, target_id: targetId, x, y };
  }
  if (actionType === Action.BACK_TO_WORK || actionType === Action.DELETE) {
    const [objectId] = data.unpack("<I");
    payload = { object_ids: [objectId] };
  }
  if (actionType === Action.WALL) {
    const [selected, x1, y1, x2, y2, buildingId] = data.unpack("<IHHHHI");
    data.read(8);
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds, x: x1, y: y1, x_end: x2, y_end: y2, building_id: buildingId };
  }
  if (actionType === Action.PATROL || actionType === Action.DE_ATTACK_MOVE) {
    const [selected, x, y] = data.unpack("<I4xf36xf36x");
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds, x, y };
  }
  if (actionType === Action.UNGARRISON) {
    const [selected, x, y, targetId] = data.unpack("<IffiI");
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds, x, y, target_id: targetId };
  }
  if (actionType === Action.FLARE) {
    const [x, y, num] = data.unpack("<4xffb");
    const targets = data.unpack(`<${num}b`);
    payload = { x, y, targets };
  }
  if (actionType === Action.TOWN_BELL) {
    const [buildingId, mode] = data.unpack("<Ib");
    payload = { building_id: buildingId, mode };
  }
  if (actionType === Action.STOP) {
    const [selected] = data.unpack("<I");
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds };
  }
  if (actionType === Action.FOLLOW || actionType === Action.GUARD) {
    const [selected, targetId] = data.unpack("<II");
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds, target_id: targetId };
  }
  if (actionType === Action.ATTACK_GROUND) {
    const [selected, x, y] = data.unpack("<Iff");
    data.read(4);
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds, x, y };
  }
  if (actionType === Action.REPAIR) {
    const [selected, targetId] = data.unpack("<II");
    data.read(4);
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds, target_id: targetId };
  }
  if (actionType === Action.DE_TRIBUTE) {
    const [wood, food, gold, stone] = data.unpack("<ffff");
    data.read(16); // cost[4]
    data.read(8); // attribute id[4]
    const targetId = bytesCopy(data.read(1));
    payload = { target_player_id: targetId, food, wood, stone, gold };
  }
  if (actionType === Action.GATE || actionType === Action.DROP_RELIC) {
    const [objectId] = data.unpack("<I");
    payload = { object_ids: [objectId] };
  }
  if (actionType === Action.DE_AUTOSCOUT || actionType === Action.RATHA_ABILITY) {
    const [selected] = data.unpack("<I");
    const objectIds = data.unpack(`${selected}I`);
    payload = { object_ids: objectIds };
  }
  if (actionType === Action.MAKE) {
    const [buildingId, unitId] = data.unpack("<H6xh");
    payload = { building_id: buildingId, unit_id: unitId };
  }
  return { player_id: playerId, ...payload };
}

/* ------------------------------------------------------------------ */
/* mgz.fast -- body operations                                         */
/* ------------------------------------------------------------------ */

const MAX_PLAYERS = 8;
const SYNC_LEN_PER_PLAYER = 11;

/** Parse player, objects, and coordinates from actions (pre-71094 layouts). */
function parseAction(actionType: Rec, data: Rec) {
  const [playerId0, length] = unpackFrom("<bh", data);
  if (data.length === length + 3) return parseAction71094(actionType, playerId0, data.subarray(3));
  if (actionType === Action.RESIGN) return { player_id: data[0] };
  if (actionType === Action.TRIBUTE) {
    const [playerId, playerIdTo, resourceId, amount, fee] = unpackFrom("<bbbff", data);
    return { player_id: playerId, player_id_to: playerIdTo, resource_id: resourceId, amount, fee };
  }
  if (actionType === Action.DE_TRIBUTE) {
    const [playerId, playerIdTo, , , wood, food, gold, stone] = unpackFrom("<bbbiffff", data);
    return { player_id: playerId, player_id_to: playerIdTo, food, wood, stone, gold };
  }
  if (actionType === Action.MOVE) {
    const [playerId, selected, x, y] = unpackFrom("<b6xI2f", data);
    let objectIds = [];
    if (selected !== 255) {
      let offset = 0;
      if (checkFlags(unpackFrom("<4b", data.subarray(19)))) offset = 4;
      objectIds = unpackFrom(`<${selected}I`, data.subarray(19 + offset));
    }
    return { player_id: playerId, x, y, object_ids: objectIds };
  }
  if (actionType === Action.CREATE) {
    const [playerId, x, y] = unpackFrom("<3xhx2f", data);
    return { player_id: playerId, x, y };
  }
  if (actionType === Action.ORDER) {
    const [playerId, targetId, selected, x, y] = unpackFrom("<b2xIh2x2f", data);
    let objectIds = [];
    if (selected !== 255) {
      let offset = 0;
      if (checkFlags(unpackFrom("<4b", data.subarray(19)))) offset = 4;
      objectIds = unpackFrom(`<${selected}I`, data.subarray(19 + offset));
    }
    return { player_id: playerId, target_id: targetId, x, y, object_ids: objectIds };
  }
  if (actionType === Action.BUILD) {
    const [playerId, x, y, buildingId] = unpackFrom("<xh2fI", data);
    return { player_id: playerId, x, y, building_id: buildingId };
  }
  if (actionType === Action.STANCE) {
    const [stanceId, ...objectIds] = unpackFrom(`<xb${data[0]}I`, data);
    return { object_ids: objectIds, stance_id: stanceId };
  }
  if (actionType === Action.RESEARCH) {
    const [objectId, playerId] = unpackFrom("<3xIh", data);
    let technologyId;
    if (data.length >= 19) [technologyId] = unpackFrom("<I", data.subarray(11, 15));
    else [technologyId] = unpackFrom("<h", data.subarray(9, 11));
    return { player_id: playerId, technology_id: technologyId, object_ids: [objectId] };
  }
  if (actionType === Action.FORMATION) {
    const [playerId, formationId, ...objectIds] = unpackFrom(`<xhI${data[0]}I`, data);
    return { player_id: playerId, object_ids: objectIds, formation_id: formationId };
  }
  if (actionType === Action.QUEUE) {
    const [objectId, unitId, amount] = unpackFrom("<3xIhh", data);
    return { object_ids: [objectId], unit_id: unitId, amount };
  }
  if (actionType === Action.GATHER_POINT) {
    const [targetId, x, y, ...objectIds] = unpackFrom(`<3xi4x2f${data[0]}I`, data);
    return { object_ids: objectIds, x, y, target_id: targetId };
  }
  if (actionType === Action.MULTIQUEUE) {
    const [unitId, amount, ...objectIds] = unpackFrom(`<3xhxb${data[5]}I`, data);
    return { object_ids: objectIds, unit_id: unitId, amount };
  }
  if (actionType === Action.PATROL) {
    const [x, y, ...objectIds] = unpackFrom(`<3xf36xf36x${data[0]}I`, data);
    return { object_ids: objectIds, x, y };
  }
  if (actionType === Action.SPECIAL) {
    const [targetId, orderId, x, y, ...flags] = unpackFrom("<3xib3x2f4x4b", data);
    let offset = 0;
    if (checkFlags(flags)) offset = 4;
    const objectIds = unpackFrom(`<${data[0]}I`, data.subarray(23 + offset));
    const values = { object_ids: objectIds, order_id: orderId };
    if (x > 0 && y > 0) Object.assign(values, { x, y });
    if (targetId > 0) Object.assign(values, { target_id: targetId });
    return values;
  }
  if (actionType === Action.BACK_TO_WORK) {
    const [objectId] = unpackFrom("<3xI", data);
    return { object_ids: [objectId] };
  }
  if (actionType === Action.UNGARRISON) {
    const [selected] = unpackFrom("<h", data);
    const [x, y, ...objectIds] = unpackFrom(`<3x2f8x${selected}I`, data);
    if (x > 0 && y > 0) return { object_ids: objectIds, x, y };
    return { object_ids: objectIds };
  }
  if (actionType === Action.BUY || actionType === Action.SELL) {
    const [playerId, resourceId, amount] = unpackFrom("<bbb", data);
    return { player_id: playerId, resource_id: resourceId, amount };
  }
  if (actionType === Action.DELETE) {
    const [objectId, playerId] = unpackFrom("<3x2I", data);
    return { player_id: playerId, object_ids: [objectId] };
  }
  if (actionType === Action.TOWN_BELL) {
    const [objectId] = unpackFrom("<3xI", data);
    return { object_ids: [objectId] };
  }
  if (actionType === Action.WALL) {
    const [selectionCount] = unpackFrom("b", data);
    const offset = data.length - selectionCount * 4;
    let values;
    if (offset > 15) {
      // In DE recordings all coordinates are prefixed with a zero.
      values = unpackFrom("<bxbxbxbxbx2h1i", data, 1);
    } else {
      values = unpackFrom("<5bx2h1i", data, 1);
    }
    const [playerId, xStart, yStart, xEnd, yEnd, buildingId] = values;
    const objectIds = unpackFrom(`<${selectionCount}I`, data.subarray(offset));
    return {
      player_id: playerId,
      x: xStart,
      y: yStart,
      x_end: xEnd,
      y_end: yEnd,
      building_id: buildingId,
      object_ids: objectIds,
    };
  }
  if (actionType === Action.GAME) return { player_id: data[1], command_id: data[0] };
  if (actionType === Action.FLARE) {
    const [x, y, playerId] = unpackFrom("<19x2fb", data);
    return { player_id: playerId, x, y };
  }
  if (actionType === Action.REPAIR) {
    const [targetId, ...flags] = unpackFrom("<3xI4b", data);
    let offset = 0;
    if (checkFlags(flags)) offset = 4;
    const objectIds = unpackFrom(`<${data[0]}I`, data.subarray(7 + offset));
    return { target_id: targetId, object_ids: objectIds };
  }
  if (actionType === Action.STOP) {
    const objectIds = unpackFrom(`<x${data[0]}I`, data);
    return { object_ids: objectIds };
  }
  if (actionType === Action.GATE) {
    const [objectId] = unpackFrom("<3xI", data);
    return { object_ids: [objectId] };
  }
  if (actionType === Action.FOLLOW) {
    const objectIds = unpackFrom(`<7x${data[0]}I`, data);
    return { object_ids: objectIds };
  }
  if (actionType === Action.GUARD) {
    const objectIds = unpackFrom(`<7x${data[0]}I`, data);
    return { object_ids: objectIds };
  }
  if (actionType === Action.ATTACK_GROUND) {
    let objectIds = [];
    const [selected, x, y, ...flags] = unpackFrom("<b2x2f4b", data);
    let offset = 0;
    if (checkFlags(flags)) offset = 4;
    if (selected > 0) objectIds = unpackFrom(`<${selected}I`, data.subarray(11 + offset));
    return { object_ids: objectIds, x, y };
  }
  if (actionType === Action.ADD_WAYPOINT) {
    let objectIds = [];
    const [selected, x, y] = unpackFrom("<xb2b", data);
    if (selected > 0) objectIds = unpackFrom(`<4x${selected}I`, data);
    return { object_ids: objectIds, x, y };
  }
  if (actionType === Action.DE_QUEUE) {
    const [playerId, unitId, amount, ...objectIds] = unpackFrom(`<b4xhbx${data[3]}I`, data);
    return { player_id: playerId, object_ids: objectIds, amount, unit_id: unitId };
  }
  if (actionType === Action.DE_ATTACK_MOVE) {
    const [x, y, ...objectIds] = unpackFrom(`<3xf36xf36x${data[0]}I`, data);
    return { object_ids: objectIds, x, y };
  }
  if (actionType === Action.DE_AUTOSCOUT) {
    const objectIds = unpackFrom(`<x${data[0]}I`, data);
    return { object_ids: objectIds };
  }
  return {};
}

/** Handle synchronizations. */
function sync(data: Rec) {
  const [increment, marker] = unpackFrom("<II", data.read(8));
  if (marker) {
    data.seek(-4, 1);
    return [increment, null, {}];
  }
  const chunk = data.read(16);
  let [checksum, isDe] = unpackFrom("<4xI4xI", chunk);
  if (!isDe) {
    data.read(8);
    return [increment, checksum, {}];
  }
  data.seek(-16, 1);
  const values = unpackFrom(
    `<${MAX_PLAYERS * SYNC_LEN_PER_PLAYER}I`,
    data.read(4 * MAX_PLAYERS * SYNC_LEN_PER_PLAYER));
  /*
   * These values are just guesses, so they might be incorrect.
   * val 1: total resources (wood + food + gold + stone), probably rounded down
   * val 3: number of displayable objects
   * val 4: displayable object TTL in seconds + resource on villagers
   * val 6: number of objects (includes foundations)
   * val 8: player ID, from 1 to 8
   */
  const [currentTime] = unpackFrom("<I", data.read(4)); // duration from beginning in ms
  const payload: Rec = { current_time: currentTime };
  for (let ptr = 0; ptr < MAX_PLAYERS * SYNC_LEN_PER_PLAYER; ptr += SYNC_LEN_PER_PLAYER) {
    if (values[ptr + 1]) {
      payload[values[ptr + 8]] = {
        total_res: values[ptr + 1],
        dp_obj_count: values[ptr + 3],
        dp_obj_ttl: values[ptr + 4],
        obj_count: values[ptr + 6],
      };
    }
  }
  return [increment, values.reduce((a, b) => a + b, 0), payload];
}

function viewlock(data: Rec) {
  const [x, y] = unpackFrom("<ffI", data.read(12));
  return [x, y];
}

function action(data: Rec, sequence = null) {
  const [length] = unpackFrom("<I", data.read(4));
  const actionIdBuf = data.read(1);
  if (actionIdBuf.length < 1) throw new StructError("no action id");
  const actionId = actionIdBuf[0];
  const actionBytes = data.read(length - 1);
  if (sequence === null) [sequence] = unpackFrom("<I", data.read(4));
  if (!(actionId in ACTION_NAMES)) throw new Error(`${actionId} is not a valid Action`);
  const actionType = actionId;
  let payload: Rec;
  if (actionType === Action.POSTGAME) {
    payload = { bytes: bytesConcat([actionBytes, data.read()]) };
  } else {
    try {
      payload = parseAction(actionType, actionBytes);
    } catch (err) {
      if (err instanceof StructError || err instanceof RangeError) return [Action.ERROR, {}];
      throw err;
    }
  }
  payload.sequence = sequence;
  return [actionType, payload];
}

function chatOp(data: Rec) {
  const [, length] = unpackFrom("<II", data.read(8));
  return data.read(length);
}

function saveOp(data: Rec) {
  data.seek(-4, 1);
  const pos = data.tell();
  const [length] = unpackFrom("<II", data.read(8));
  data.read(length - pos - 8);
}

/** Handle DE postgame. */
function postgame(data: Rec) {
  const reversed = new Stream(bytesCopy(data.read()).reverse());
  reversed.read(8);
  const [, numBlocks] = unpackFrom(">II", reversed.read(8));
  const out: Rec = {};
  for (let i = 0; i < numBlocks; i++) {
    const [identifier, length] = unpackFrom(">II", reversed.read(8));
    const block = new Stream(bytesCopy(reversed.read(length)).reverse());
    if (identifier === Postgame.WORLD_TIME) {
      out.world_time = unpackFrom("<I", block.read(4))[0];
    } else if (identifier === Postgame.LEADERBOARDS) {
      const [numLeaderboards] = unpackFrom("<I", block.read(4));
      const leaderboards = [];
      for (let lb = 0; lb < numLeaderboards; lb++) {
        const [leaderboardId] = unpackFrom("<IH", block.read(6));
        const [numPlayers] = unpackFrom("<I", block.read(4));
        const playerData = [];
        for (let p = 0; p < numPlayers; p++) {
          const [playerNum, rank, rating] = unpackFrom("<3i", block.read(12));
          playerData.push({ number: playerNum, rank, rating });
        }
        leaderboards.push({ id: leaderboardId, players: playerData });
      }
      out.leaderboards = leaderboards;
    } else {
      throw new Error("unparsed postgame block");
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* mgz.body.achievements -- the end-game score screen                  */
/* ------------------------------------------------------------------ */

/*
 * The score screen is appended to a recording as a single action of type 0xFF,
 * laid out by mgz/body/achievements.py. mgz.model -- which the rest of this
 * file ports -- drops it, so what follows is a port of that struct plus the
 * use mgz.summary makes of it, not of anything in mgz.model.
 *
 * Only UserPatch 1.4+ and HD write that action. Definitive Edition does not:
 * a DE recording ends with a POSTGAME *operation* carrying leaderboards and
 * world time (postgame() above) and no score screen at all -- verified against
 * both recordings in .data, neither of which contains action 0xFF. For those,
 * parseAchievements returns null and deriveAchievements fills in the subset
 * the body can actually support.
 */

/** One player's record inside the score screen. */
const ACHIEVEMENTS_SIZE = 252;
/** Score-screen bytes ahead of the player array. */
const ACHIEVEMENTS_OFFSET = 75;

/** mgz's convert_to_timestamp: -1 is "never reached". Milliseconds here. */
function achTime(seconds: number) {
  return seconds === -1 ? null : seconds * 1000;
}

function parsePlayerAchievements(buf: Uint8Array, off: Rec, encoding: string) {
  const nameBytes = buf.subarray(off, off + 16);
  let nameEnd = nameBytes.indexOf(0);
  if (nameEnd === -1) nameEnd = nameBytes.length;
  const [totalScore] = unpackFrom("<H", buf, off + 16);
  const totalScores = unpackFrom("<8H", buf, off + 18);
  const [victory, civilizationId, colorId, team, allyCount, randomCiv, mvp] =
    unpackFrom("<7B", buf, off + 34);
  const [result] = unpackFrom("<I", buf, off + 44);
  const [
    militaryScore, unitsKilled, hitPointsKilled, unitsLost,
    buildingsRazed, hitPointsRazed, buildingsLost, unitsConverted,
  ] = unpackFrom("<8H", buf, off + 48);
  const [economyScore] = unpackFrom("<H", buf, off + 96);
  const [food, wood, stone, gold] = unpackFrom("<4I", buf, off + 100);
  const [tributeSent, tributeReceived, tradeGold, relicGold] =
    unpackFrom("<4H", buf, off + 116);
  const [technologyScore] = unpackFrom("<H", buf, off + 140);
  const [feudal, castle, imperial] = unpackFrom("<3i", buf, off + 144);
  const [exploredPercent, researchCount, researchPercent] =
    unpackFrom("<3B", buf, off + 156);
  const [societyScore] = unpackFrom("<H", buf, off + 160);
  const [totalWonders, totalCastles, relicsCaptured] = unpackFrom("<3B", buf, off + 162);
  const [villagerHigh] = unpackFrom("<H", buf, off + 166);
  return {
    source: "recorded",
    // Kept raw as well: the screen truncates a long name to 16 bytes, and mgz
    // matches players by byte prefix because of it.
    name_bytes: bytesCopy(nameBytes.subarray(0, nameEnd)),
    name: decodeBytes(nameBytes.subarray(0, nameEnd), encoding),
    total_score: totalScore,
    total_scores: totalScores,
    victory: victory !== 0,
    civilization_id: civilizationId,
    color_id: colorId,
    team,
    ally_count: allyCount,
    // Never actually set by the game, per mgz. Reported as-is.
    random_civ: randomCiv !== 0,
    mvp: mvp !== 0,
    result,
    military: {
      score: militaryScore,
      units_killed: unitsKilled,
      hit_points_killed: hitPointsKilled,
      units_lost: unitsLost,
      buildings_razed: buildingsRazed,
      hit_points_razed: hitPointsRazed,
      buildings_lost: buildingsLost,
      units_converted: unitsConverted,
    },
    economy: {
      score: economyScore,
      food_collected: food,
      wood_collected: wood,
      stone_collected: stone,
      gold_collected: gold,
      tribute_sent: tributeSent,
      tribute_received: tributeReceived,
      trade_gold: tradeGold,
      relic_gold: relicGold,
    },
    technology: {
      score: technologyScore,
      feudal_time: achTime(feudal),
      castle_time: achTime(castle),
      imperial_time: achTime(imperial),
      explored_percent: exploredPercent,
      research_count: researchCount,
      research_percent: researchPercent,
    },
    society: {
      score: societyScore,
      total_wonders: totalWonders,
      total_castles: totalCastles,
      total_relics: relicsCaptured,
      villager_high: villagerHigh,
    },
  };
}

/**
 * Parse the bytes of an action 0xFF into the score screen, or null if the
 * action is absent, truncated, or does not look like the struct.
 */
function parseAchievements(bytes: Uint8Array, encoding: string, consts: Rec) {
  if (!bytes || bytes.length < ACHIEVEMENTS_OFFSET) return null;
  const [playerNum, computerNum] = unpackFrom("<2B", bytes, 35);
  if (playerNum < 1 || playerNum > MAX_PLAYERS) return null;
  if (bytes.length < ACHIEVEMENTS_OFFSET + playerNum * ACHIEVEMENTS_SIZE) return null;
  const filenameBytes = bytes.subarray(3, 35);
  let filenameEnd = filenameBytes.indexOf(0);
  if (filenameEnd === -1) filenameEnd = filenameBytes.length;
  const [duration] = unpackFrom("<I", bytes, 39);
  const [cheats, complete] = unpackFrom("<2B", bytes, 43);
  const [dbChecksum, codeChecksum] = unpackFrom("<2I", bytes, 47);
  const [version] = unpackFrom("<f", bytes, 55);
  const [mapSize, mapId] = unpackFrom("<2B", bytes, 59);
  const [population] = unpackFrom("<H", bytes, 61);
  const [
    victoryTypeId, startingAgeId, startingResourcesId, allTechs, randomPositions,
    revealMapId, isDeathmatch, isRegicide, startingUnits, lockTeams, lockSpeed,
  ] = unpackFrom("<11B", bytes, 63);
  const players = [];
  for (let i = 0; i < playerNum; i++) {
    players.push(
      parsePlayerAchievements(bytes, ACHIEVEMENTS_OFFSET + i * ACHIEVEMENTS_SIZE, encoding));
  }
  return {
    // latin-1 in mgz, regardless of the recording's encoding.
    scenario_filename: bytesToLatin1(filenameBytes.subarray(0, filenameEnd)),
    player_num: playerNum,
    computer_num: computerNum,
    duration: duration * 1000,
    cheats: cheats !== 0,
    complete: complete !== 0,
    db_checksum: dbChecksum,
    code_checksum: codeChecksum,
    version,
    map_size: mapSize,
    map_id: mapId,
    population,
    victory_type_id: victoryTypeId,
    victory_type: consts.victory_conditions[String(victoryTypeId)] || null,
    starting_age_id: startingAgeId,
    starting_age: consts.starting_ages[String(startingAgeId)] || null,
    starting_resources_id: startingResourcesId,
    starting_resources: consts.starting_resources[String(startingResourcesId)] || null,
    all_technologies: allTechs !== 0,
    random_positions: randomPositions !== 0,
    map_reveal_id: revealMapId,
    map_reveal: consts.map_reveal_choices[String(revealMapId)] || null,
    is_deathmatch: isDeathmatch !== 0,
    is_regicide: isRegicide !== 0,
    starting_units: startingUnits,
    lock_teams: lockTeams !== 0,
    lock_speed: lockSpeed !== 0,
    players,
  };
}

/** mgz's get_achievements: the screen truncates names, so match on a prefix. */
function findAchievements(postgame: Rec, name: Rec) {
  if (!postgame) return null;
  for (const record of postgame.players) {
    if (record.name && name.startsWith(record.name)) return record;
  }
  return null;
}

/** An all-null score screen, for a player the recording says nothing about. */
function emptyAchievements(source: Rec): Rec {
  return {
    source,
    total_score: null,
    victory: null,
    mvp: null,
    military: {
      score: null, units_killed: null, hit_points_killed: null, units_lost: null,
      buildings_razed: null, hit_points_razed: null, buildings_lost: null,
      units_converted: null,
    },
    economy: {
      score: null, food_collected: null, wood_collected: null, stone_collected: null,
      gold_collected: null, tribute_sent: null, tribute_received: null,
      trade_gold: null, relic_gold: null,
    },
    technology: {
      score: null, feudal_time: null, castle_time: null, imperial_time: null,
      explored_percent: null, research_count: null, research_percent: null,
    },
    society: {
      score: null, total_wonders: null, total_castles: null, total_relics: null,
      villager_high: null,
    },
  };
}

const AGE_ACHIEVEMENT_FIELD = {
  [Age.FEUDAL_AGE]: "feudal_time",
  [Age.CASTLE_AGE]: "castle_time",
  [Age.IMPERIAL_AGE]: "imperial_time",
};

/**
 * The subset of the score screen a Definitive Edition recording can support.
 *
 * Nothing here comes from the game's own tally -- there isn't one in the file
 * -- so every field is reconstructed from the body, and is only as good as its
 * source:
 *
 *   feudal/castle/imperial_time  exact. The game announces each advance.
 *   research_count               distinct research *orders*, so a cancelled or
 *                                queued-but-unfinished tech still counts.
 *   tribute_sent/received        exact amounts, fees excluded, over both the
 *                                AoC and the DE tribute actions.
 *   total_wonders/total_castles  build *orders* placed, not foundations that
 *                                finished, and a razed one still counts.
 *
 * Everything the body genuinely cannot see -- kills, losses, razings,
 * conversions, resources gathered, explored percentage, relics, and the four
 * category scores -- stays null rather than being guessed at.
 *
 * `snapshot` is not part of the score screen. It is what the DE sync stat rows
 * carry, which is the closest the format comes to an economy total, exposed
 * alongside so a caller has something real to show where the gathered-resource
 * counters would have gone.
 */
function deriveAchievements(players: Rec, uptimes: Rec, actions: Rec) {
  const byNumber = new Map();
  for (const player of players) {
    const record = emptyAchievements("derived");
    record.economy.tribute_sent = 0;
    record.economy.tribute_received = 0;
    record.society.total_wonders = 0;
    record.society.total_castles = 0;
    record.snapshot = {
      final_total_resources: null,
      peak_total_resources: null,
      final_objects: null,
      peak_objects: null,
    };
    byNumber.set(player.number, record);
    player.achievements = record;
  }

  for (const uptime of uptimes) {
    if (!uptime.player) continue;
    const record = byNumber.get(uptime.player.number);
    const field = AGE_ACHIEVEMENT_FIELD[uptime.age];
    if (!record || !field) continue;
    if (record.technology[field] === null) record.technology[field] = uptime.timestamp;
  }

  const researched = new Map();
  for (const action of actions) {
    if (!action.player) continue;
    const record = byNumber.get(action.player.number);
    if (!record) continue;
    if (action.type === Action.RESEARCH) {
      if (!researched.has(action.player.number)) researched.set(action.player.number, new Set());
      researched.get(action.player.number).add(action.payload.technology_id);
    } else if (action.type === Action.BUILD) {
      if (action.payload.building === "Wonder") record.society.total_wonders += 1;
      else if (action.payload.building === "Castle") record.society.total_castles += 1;
    } else if (action.type === Action.TRIBUTE || action.type === Action.DE_TRIBUTE) {
      const amount = action.type === Action.TRIBUTE
        ? action.payload.amount
        : action.payload.food + action.payload.wood
          + action.payload.stone + action.payload.gold;
      record.economy.tribute_sent += amount;
      // DE_TRIBUTE's target is a one-byte copy on the 71094+ path and a plain
      // number on the older one; normalise before looking the player up.
      const rawTarget = action.payload.player_id_to !== undefined
        ? action.payload.player_id_to : action.payload.target_player_id;
      const target = typeof rawTarget === "number" ? rawTarget
        : (rawTarget && rawTarget.length ? rawTarget[0] : null);
      const targetRecord = target === null ? null : byNumber.get(target);
      if (targetRecord) targetRecord.economy.tribute_received += amount;
    }
  }
  for (const [number, techs] of researched) {
    byNumber.get(number).technology.research_count = techs.size;
  }

  for (const player of players) {
    const record = byNumber.get(player.number);
    if (!player.timeseries.length) continue;
    const last = player.timeseries[player.timeseries.length - 1];
    record.snapshot.final_total_resources = last.total_resources;
    record.snapshot.final_objects = last.total_objects;
    let peakRes = 0;
    let peakObj = 0;
    for (const row of player.timeseries) {
      if (row.total_resources > peakRes) peakRes = row.total_resources;
      if (row.total_objects > peakObj) peakObj = row.total_objects;
    }
    record.snapshot.peak_total_resources = peakRes;
    record.snapshot.peak_objects = peakObj;
  }
}

/** Attach the recorded score screen where there is one, derive it otherwise. */
function attachAchievements(players: Rec, postgame: Rec, uptimes: Rec, actions: Rec) {
  if (!postgame) {
    deriveAchievements(players, uptimes, actions);
    return;
  }
  for (const player of players) {
    player.achievements = findAchievements(postgame, player.name)
      || emptyAchievements("recorded");
  }
}

/** Handle log meta. */
function meta(data: Rec) {
  try {
    const [first] = data.unpack("<I");
    if (first !== 500) data.read(4); // Not AOK
    data.read(20);
    const [a, b] = data.unpack("<III");
    if (a !== 0) data.seek(-12, 1); // AOC 1.0x
    if (b === 2) data.seek(-8, 1); // DE
  } catch (err) {
    if (err instanceof StructError) throw new Error("insufficient meta received");
    throw err;
  }
}

class EOFError extends Error {}

/**
 * A chapter marker: the start block, again, in the middle of the body.
 *
 * A campaign mission is recorded in chapters, and each one repeats the block
 * the body opens with. mgz's fast reader has no branch for it -- it is the
 * one operation id in the enum that reader does not handle -- so the first
 * chapter boundary ended the parse with "unknown data received". Nothing in
 * it is worth keeping; the point is to arrive at the operation after it.
 *
 * The shape is mgz's `start` struct (mgz/body/__init__.py): six int32s, of
 * which the operation id already read is the first, and then a tail that is
 * only present when the field after them is zero.
 */
function startOp(data: Rec) {
  data.read(20);
  const [next] = data.unpack("<I");
  data.seek(-4, 1);
  if (next === 0) {
    data.read(4);
    const [aok] = data.unpack("<I");
    data.seek(-4, 1);
    if (aok !== 2) data.read(4);
  }
  return null;
}

/** Handle body operations. */
function operation(data: Rec) {
  let opId;
  try {
    [opId] = data.unpack("<I");
    if (!(opId in OPERATION_NAMES)) return [Operation.SAVE, saveOp(data)];
    if (opId === Operation.ACTION) return [opId, action(data)];
    if (opId === Operation.SYNC) return [opId, sync(data)];
    if (opId === Operation.VIEWLOCK) return [opId, viewlock(data)];
    if (opId === Operation.CHAT) return [opId, chatOp(data)];
    if (opId === Operation.POSTGAME) return [opId, postgame(data)];
    if (opId === Operation.START) return [opId, startOp(data)];
  } catch (err) {
    if (err instanceof StructError || err instanceof RangeError) throw new EOFError();
    throw err;
  }
  throw new Error("unknown data received");
}

/* ------------------------------------------------------------------ */
/* mgz.common.chat                                                     */
/* ------------------------------------------------------------------ */

const FEUDAL_AGE_MARKERS = [
  "봉건 시대", "Edad Feudal", "封建时代", "Feudalzeit", "Feodal Çağ", "封建時代",
  "Edad Feudal", "領主の時代", "Zaman Feudal", "Età feudale", "Feudal Age",
  "Thời phong kiến", "सामंतवादी युग", "Era Feudalna", "Idade Feudal", "Âge féodal",
  "Феодальная эпоха",
];
const CASTLE_AGE_MARKERS = [
  "성주 시대", "Ed. Castillos", "城堡时代", "Ritterzeit", "Kale Çağı", "城堡時代",
  "Edad de los Castillos", "城主の時代", "Zaman Kastil", "Età dei castelli",
  "Castle Age", "Thời lâu đài", "परिवर्तन युग", "Era Zamków", "Idade dos Castelos",
  "Âge des châteaux", "Замковая эпоха", "Kale Çağı",
];
const IMPERIAL_AGE_MARKERS = [
  "왕정 시대", "Edad Imperial", "帝王时代", "Imperialzeit", "İmparatorluk Çağı",
  "帝王時代", "Edad Imperial", "帝王の時代", "Zaman Empayar", "Età imperiale",
  "Imperial Age", "Thời đế quốc", "साम्राज्यवादी युग", "Era Imperiów",
  "Idade Imperial", "Âge impérial", "Имперская эпоха",
];
const AGE_MARKERS = [
  "advanced to the", "a progressé vers", "升级至", "avanzó a la", "đã phát triển lên",
  "시대로 발전했습니다", "vorangeschritten", "переход в", "avançou para a Idade",
  "wkroczyło w Erę", "升級至", "passaggio", "geÃ§ti", "進化し", "avançou para",
  "новую эпоху", "avanzó a Edad", "avanzado a la Edad", "ha raggiunto", "avanzó a Ed",
  "đã nâng cấp", "progressé vers", "wkracza do", "युग में उन्नत है।", "telah mara ke",
  "geçti", "çağına ulaştı",
];
const SAVE_MARKERS = [
  "Continuar con la partida en vez de guardar y salir",
  "Voto iniciado para guardar y salir del juego",
  "Chose to continue the game instead of save and exit",
  "Initiated vote to save and exit the game",
  "Vyber pokračovat ve hře místo ulo",
  "Escolha para continuar o jogo em vez de salvá-lo e fechá-lo",
  "Выберете Продолжить Игру вместо Сохранить и Выйти.",
  "Choisir pour continuer la partie au lieu d'enregistrer et quitter.",
];

function parseChat(line: Rec, encoding: string, timestamp: Rec, players: Rec, diplomacyType: Rec = null, origination = "game"): Rec {
  const data: Rec = { timestamp, origination };
  let text;
  try {
    text = decodeBytes(stripNulls(line), encoding);
  } catch (err) {
    data.type = Chat.DISCARD;
    return data;
  }
  for (const saveMarker of SAVE_MARKERS) {
    if (text.indexOf(saveMarker) > 0) {
      data.type = Chat.SAVE;
      return data;
    }
  }
  if (text.indexOf("Voobly: Ratings provided") > 0) parseLadderChat(data, text);
  else if (text.indexOf("Voobly") === 3) parseVooblyChat(data, text);
  else if (text.indexOf("<Rating>") > 0) parseRatingChat(data, text);
  else if (text.indexOf("@#0<") === 0) parseInjectedChat(data, text);
  else if (text.indexOf("--") === 3) data.type = Chat.HELP;
  else if (text.startsWith('{"')) parseJsonChat(data, text, diplomacyType);
  else parsePlainChat(data, text, players, diplomacyType);

  if (data.type !== Chat.DISCARD) {
    for (const ageMarker of AGE_MARKERS) {
      if (text.indexOf(ageMarker) > 0) {
        if (FEUDAL_AGE_MARKERS.some((m) => text.includes(m))) data.age = Age.FEUDAL_AGE;
        if (CASTLE_AGE_MARKERS.some((m) => text.includes(m))) data.age = Age.CASTLE_AGE;
        if (IMPERIAL_AGE_MARKERS.some((m) => text.includes(m))) data.age = Age.IMPERIAL_AGE;
        if ("age" in data) data.type = Chat.AGE;
      }
    }
  }

  // Chat messages can be bugged - check for invalid messages.
  if ("player_number" in data && !players.some((p: Rec) => p.number === data.player_number)) {
    data.type = Chat.DISCARD;
  }
  return data;
}

function parseJsonChat(data: Rec, line: Rec, diplomacyType: Rec) {
  const payload = JSON.parse(line);
  if (payload.messageAGP === "") {
    // Tells us to ignore the chat; it might be from another game, for example.
    data.type = Chat.DISCARD;
    return;
  }
  let audience = "team";
  if (payload.channel === 0) {
    if (diplomacyType === "1v1") audience = "all";
  } else if (payload.channel === 1) {
    audience = "all";
  }
  Object.assign(data, {
    type: Chat.MESSAGE,
    player_number: payload.player,
    message: pyStrip(payload.message),
    audience,
  });
}

function parseLadderChat(data: Rec, line: Rec) {
  const start = line.indexOf("'") + 1;
  const end = line.indexOf("'", start);
  Object.assign(data, { type: Chat.LADDER, ladder: line.slice(start, end) });
}

function parseVooblyChat(data: Rec, line: Rec) {
  Object.assign(data, { type: Chat.VOOBLY, message: line.slice(11) });
}

function parseRatingChat(data: Rec, line: Rec) {
  const playerStart = line.indexOf(">") + 2;
  const playerEnd = line.indexOf(":", playerStart);
  Object.assign(data, {
    type: Chat.RATING,
    player: line.slice(playerStart, playerEnd),
    rating: parseInt(line.slice(playerEnd + 2), 10),
  });
}

function parseInjectedChat(data: Rec, line: Rec) {
  let prefix = "";
  if (line.indexOf("<Team>") > 0) {
    line = line.replace("<Team>", "");
    prefix = ";";
  }
  const originationStart = line.indexOf("<") + 1;
  const originationEnd = line.indexOf(">", originationStart);
  const origination = line.slice(originationStart, originationEnd);
  const nameEnd = line.indexOf(":", originationEnd);
  Object.assign(data, {
    type: Chat.INJECTED,
    origination: origination.toLowerCase(),
    name: line.slice(originationEnd + 2, nameEnd),
    message: `${prefix}${line.slice(nameEnd + 2)}`,
  });
}

function parsePlainChat(data: Rec, line: Rec, players: Rec, diplomacyType: Rec) {
  if (!line || line.length < 5) {
    data.type = Chat.DISCARD;
    return;
  }
  let playerStart = line.indexOf("#") + 2;
  if (line[4] === " ") playerStart = line.indexOf(" ") + 1;
  const playerEnd = line.indexOf(":", playerStart);
  let player = line.slice(playerStart, playerEnd);
  let group;
  if (data.timestamp === 0) group = "All";
  else if (diplomacyType === "TG") group = "Team";
  else group = "All";
  if (player.indexOf(">") > 0) {
    group = player.slice(1, player.indexOf(">"));
    player = player.slice(player.indexOf(">") + 1);
  }
  if (["todos", "всем", "tous"].includes(group.toLowerCase())) group = "All";
  else if (["隊伍", "squadra"].includes(group.toLowerCase())) group = "Team";
  const message = line.slice(playerEnd + 2);
  let number = null;
  for (const p of players) {
    if (p.name && player.includes(p.name)) number = p.number;
  }
  if (!number && line.startsWith("@#")) number = parseInt(line[2], 10);
  Object.assign(data, {
    type: Chat.MESSAGE,
    player_number: number,
    message: pyStrip(message),
    audience: group.toLowerCase(),
  });
}

/** Python's str.strip() with no argument. */
function pyStrip(text: string) {
  return String(text).replace(/^\s+|\s+$/g, "");
}

/* ------------------------------------------------------------------ */
/* mgz.common.map                                                      */
/* ------------------------------------------------------------------ */

/**
 * ENCODING_MARKERS / LANGUAGE_MARKERS from mgz.common.map, with each marker
 * pre-encoded to the bytes Python's `marker.encode(encoding)` produces -- Node
 * has decoders for these code pages but no encoders.
 */
const ENCODING_MARKERS = [
  ["4d617020547970653a20", "latin-1", "en"],
  ["4d617020747970653a20", "latin-1", "en"],
  ["4c6f636174696f6e3a20", "utf-8", "en"],
  ["5469706f206465206d6170613a20", "latin-1", "es"],
  ["55626963616369c3b36e3a20", "utf-8", "es"],
  ["556269636163693a20", "utf-8", "es"],
  ["4c6f63616c3a20", "utf-8", "es"],
  ["4b617274656e7479703a20", "latin-1", "de"],
  ["4b617274653a20", "utf-8", "de"],
  ["41727420646572204b617274653a20", "latin-1", "de"],
  ["54797065206465206361727465a03a20", "latin-1", "fr"],
  ["456d706c6163656d656e74c2a03a", "utf-8", "fr"],
  ["54797065206465206361727465203a20", "latin-1", "fr"],
  ["5469706f206469206d617070613a20", "latin-1", "it"],
  ["506f73697a696f6e653a20", "utf-8", "it"],
  ["5469706f206465204d6170613a20", "latin-1", "pt"],
  ["4b6161727474797065", "latin-1", "nl"],
  ["4c6f6b616c697a61636a613a20", "utf-8", "pl"],
  ["4861726974612054fc72fc3a20", "ISO-8859-1", "tr"],
  ["48617269746120536974696c69", "ISO-8859-1", "tr"],
  ["4861726974612074697069", "ISO-8859-1", "tr"],
  ["4b6f6e756d3a20", "ISO-8859-1", "tr"],
  ["3f3f3f203f3f3f3f3f3a20", "ascii", "tr"],
  ["54e9726be97020746970757361", "ISO-8859-1", "hu"],
  ["547970206d6170793a20", "ISO-8859-2", null],
  ["d2e8ef20eae0f0f2fb3a20", "windows-1251", "ru"],
  ["d2e8ef20cae0f0f2fb3a20", "windows-1251", "ru"],
  ["d0a0d0b0d181d0bfd0bed0bbd0bed0b6d0b5d0bdd0b8d0b53a20", "utf-8", "ru"],
  ["837d8362837682cc8eed97de3a20", "SHIFT_JIS", "jp"],
  ["e3839ee38383e3839720", "utf-8", "jp"],
  ["c1f6b5b520c1beb7f93a20", "cp949", "kr"],
  ["a6613f3fabac", "big5", "zh"],
  ["b5d8cdbcc0e0d0cd3a20", "cp936", "zh"],
  ["b5d88844ee908465a3ba", "cp936", "zh"],
  ["a661b9cfc3fea74fa147", "big5", "zh"],
  ["b5d8cdbcc0e0b1f0a3ba", "cp936", "zh"],
  ["b5d8cdbcc0e0d0cda3ba", "GB2312", "zh"],
  ["f2a2d3f1d7bedcaca3ba", "cp936", "zh"],
  ["e4bd8de7bdaeefbc9a", "utf-8", "zh"],
  ["e8889ee58fb03a20", "utf-8", "zh"],
  ["56e1bb8b207472c3ad3a20", "utf-8", "vi"],
  ["ec9c84ecb9983a20", "utf-8", "kr"],
  ["cea4cf8dcf80cebfcf8220cea7ceaccf81cf84ceb73a20", "utf-8", "gr"],
  ["456d706c6163656d656e743a20", "utf-8", "fr"],
  ["4c6f63616c3a20", "utf-8", "pt"],
  ["4d6170613a20", "utf-8", "cs"],
  ["506c6174733a20", "utf-8", "se"],
].map(([hex, encoding, language]) => [bytesFromHex(hex as string), encoding, language] as [Uint8Array, string, string | null]);

const LANGUAGE_MARKERS = [
  ["446f737465706e65", "ISO-8859-2", "pl"],
  ["6f737a756b6977616e6961", "ISO-8859-2", "pl"],
  ["446f7a776f6c69", "ISO-8859-2", "pl"],
  ["506f766f6c", "ISO-8859-2", "cs"],
  ["4d6f7a6e6f", "ISO-8859-2", "sk"],
  ["446f6266fd766163ed", "ISO-8859-2", "cs"],
].map(([hex, encoding, language]) => [bytesFromHex(hex as string), encoding, language] as [Uint8Array, string, string | null]);

const WATER_TERRAIN: Record<string, number[]> = {
  0: [1, 4, 15, 22, 23],
  1: [1, 4, 11, 15, 22, 23],
  7: [1, 4, 15, 22, 23],
  100: [1, 4, 15, 22, 23, 26, 54, 57, 58, 59, 93, 94, 95, 96, 97, 98, 99],
};

function splitLines(buf: Uint8Array) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lines.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  lines.push(buf.subarray(start));
  return lines;
}

function extractFromInstructions(instructions: Rec) {
  let language = null;
  let encoding = "unknown";
  let name = "Unknown";
  const lines = splitLines(instructions);
  for (const [marker, testEncoding, markerLanguage] of ENCODING_MARKERS) {
    for (const line of lines) {
      if (line.length >= marker.length && bytesEqual(line.subarray(0, marker.length), marker)) {
        encoding = testEncoding;
        name = decodeBytes(line.subarray(marker.length), encoding).split(".rms").join("");
        language = markerLanguage;
        break;
      }
    }
  }
  // Disambiguate certain languages.
  if (!language) {
    language = "unknown";
    for (const [marker, , markerLanguage] of LANGUAGE_MARKERS) {
      if (instructions.indexOf(marker) > -1) {
        language = markerLanguage;
        break;
      }
    }
  }
  if (encoding === "unknown") throw new Error("could not detect encoding");
  return [encoding, language, name];
}

/** Look up the base game map, if applicable. */
function lookupName(mapId: Rec, name: Rec, version: Rec, reference: Rec) {
  let custom = true;
  const isDe = version === Version.DE;
  const isHd = version === Version.HD;
  // 59: RM custom, 137: custom map pool, 138: DM custom
  if ((mapId !== 44 && !(isDe || isHd)) || (![59, 137, 138].includes(mapId) && (isDe || isHd))) {
    if (String(mapId) in reference.maps) {
      name = reference.maps[String(mapId)];
    } else if (version === Version.AOK) {
      return [name, false];
    } else {
      throw new Error(
        `unspecified builtin map: ${mapId} aka ${name} (${reference.dataset.name})`);
    }
    custom = false;
  }
  return [name, custom];
}

function getMapSeed(instructions: Rec) {
  const match = /\x00[^\n]*? (-?[0-9]+)\x00[^\n]*?\.rms/.exec(bytesToLatin1(instructions));
  return match ? parseInt(match[1], 10) : null;
}

/** Extract userpatch modes. */
function getModes(name: Rec) {
  const hasModes = name.indexOf(": !");
  let modeString = "";
  if (hasModes > -1) {
    modeString = name.slice(hasModes + 3);
    name = name.slice(0, hasModes);
  }
  return [name, {
    direct_placement: modeString.includes("P"),
    effect_quantity: modeString.includes("C"),
    guard_state: modeString.includes("G"),
    fixed_positions: modeString.includes("F"),
  }];
}

function getTiles(tiles: Rec, dimension: Rec) {
  const out = [];
  let tileX = 0;
  let tileY = 0;
  for (const tile of tiles) {
    if (tileX === dimension) {
      tileX = 0;
      tileY += 1;
    }
    out.push({ x: tileX, y: tileY, terrain_id: tile[0], elevation: tile[1] });
    tileX += 1;
  }
  return out;
}

function getWaterPercent(tiles: Rec, datasetId: Rec) {
  if (!(datasetId in WATER_TERRAIN)) return null;
  let count = 0;
  for (const tile of tiles) if (WATER_TERRAIN[datasetId].includes(tile[0])) count++;
  return count / tiles.length;
}

function getMapData(mapId: Rec, instructions: Rec, dimension: Rec, version: Rec, datasetId: Rec, reference: Rec, tiles: Rec, deSeed: Rec, mapSizes: Rec, scenarioFilename: Rec): Rec {
  if (instructions.length === 1 && instructions[0] === 0) throw new Error("empty instructions");
  let encoding;
  let language;
  let name;
  let scenario = false;
  try {
    [encoding, language, name] = extractFromInstructions(instructions);
  } catch (err) {
    /* A lobby game puts "Map Type: Arabia" at the top of the instructions,
       and that line is where the map's name and the encoding come from. A
       scenario has the mission's briefing there instead, so there is no line
       to read -- and the map is the scenario, which names itself. */
    if (!scenarioFilename) throw err;
    scenario = true;
    encoding = "utf-8";
    language = "unknown";
    name = scenarioFilename.replace(/\.aoe2scenario$/i, "");
  }
  if (datasetId === 100) encoding = "utf-8";
  /* A scenario is its own map: there is no builtin to look the id up in, and
     the id a scenario game carries is not one (-3, unsigned). */
  let custom = true;
  if (!scenario) [name, custom] = lookupName(mapId, name, version, reference);
  const seed = getMapSeed(instructions);
  let modes;
  [name, modes] = getModes(name);
  return [{
    id: custom ? null : mapId,
    name: pyStrip(name),
    /* Not a random map at all: a scenario, which is how a campaign mission and
       an Art of War challenge both arrive. The name above is its filename. */
    scenario,
    size: mapSizes[String(dimension)],
    dimension,
    seed: deSeed || seed,
    mod_id: null,
    modes,
    custom,
    zr: name.startsWith("ZR@"),
    tiles: getTiles(tiles, dimension),
    water: getWaterPercent(tiles, datasetId),
  }, encoding, language];
}

/* ------------------------------------------------------------------ */
/* mgz.common.diplomacy                                                */
/* ------------------------------------------------------------------ */

function getDiplomacyType(teams: Rec, players: Rec) {
  if (teams.length === 2 && players.length > 2) return "TG";
  if (players.length === 2) return "1v1";
  if ((teams.length === players.length || teams.length === 1) && players.length > 2) return "FFA";
  return "Other";
}

/* ------------------------------------------------------------------ */
/* mgz.reference                                                       */
/* ------------------------------------------------------------------ */

/*
 * Reference data, in preference order: an explicit `{reference}` option, then
 * the ./aocref-data files on disk (Node only, via runtime.referenceDir).
 * The renderer imports the JSON directly and passes it as `{reference}`, so
 * only the CLIs ever reach the disk path.
 */
const referenceCache = { constants: null, datasets: new Map() };

function readReferenceFile(...parts: string[]) {
  if (!runtime.fs || !runtime.referenceDir) {
    throw new Error(
      "no reference data: pass {reference: {constants, datasets}}, or call "
      + "setNodeRuntime({fs, path, referenceDir})");
  }
  return JSON.parse(
    /* `path` is set alongside `fs` by setNodeRuntime, so the guard above
       covers it; asserted rather than re-checked, which would be a
       behaviour change. */
    runtime.fs.readFileSync(runtime.path!.join(runtime.referenceDir, ...parts), "utf-8"));
}

function getConsts(reference: Rec) {
  if (reference && reference.constants) return reference.constants;
  if (!referenceCache.constants) referenceCache.constants = readReferenceFile("constants.json");
  return referenceCache.constants;
}

function getDataset(version: Rec, mod: Rec, reference: Rec) {
  let datasetId;
  if (version === Version.DE) datasetId = Array.isArray(mod) && mod.includes(11) ? 101 : 100;
  else if (version === Version.HD) datasetId = 300;
  else if (mod) datasetId = mod[0];
  else datasetId = 0;
  if (reference && reference.datasets && reference.datasets[datasetId]) {
    return [datasetId, reference.datasets[datasetId]];
  }
  if (!referenceCache.datasets.has(datasetId)) {
    referenceCache.datasets.set(datasetId, readReferenceFile("datasets", `${datasetId}.json`));
  }
  return [datasetId, referenceCache.datasets.get(datasetId)];
}

/* ------------------------------------------------------------------ */
/* mgz.model                                                           */
/* ------------------------------------------------------------------ */

const TC_IDS = [71, 109, 141, 142];
const AI_ACTIONS = [Action.AI_ORDER];

const ACTION_TRANSLATE = { [Action.DE_QUEUE]: "Queue", [Action.DE_ATTACK_MOVE]: "Attack Move" };

/**
 * Refine player actions into inputs (mgz.model.inputs).
 *
 * Ported because it is not read-only: add_action rewrites the action payload it
 * is handed -- BUY/SELL amounts are scaled by 100, and an action that carries
 * no selection inherits the previous one's object_ids. parse_rec.py prints
 * those payloads, so skipping this would report market trades 100x too small.
 */
class Inputs {
  _gaia: Map<Rec, Rec>;
  _buildings: Map<string | null, Rec>;
  _oidCache: Map<Rec, Rec>;
  inputs: Rec[];

  constructor(gaia: Map<Rec, Rec>) {
    this._gaia = gaia;
    this._buildings = new Map();
    this._oidCache = new Map();
    this.inputs = [];
  }

  addChat(chat: Rec) {
    this.inputs.push({
      timestamp: chat.timestamp,
      type: "Chat",
      param: null,
      payload: { message: chat.message },
      player: chat.player,
      position: null,
    });
  }

  addAction(action: Rec) {
    if (action.type === Action.DE_TRANSFORM || action.type === Action.POSTGAME) return null;
    let name = titleCase(
      (ACTION_TRANSLATE[action.type] || ACTION_NAMES[action.type]).replace(/_/g, " "));
    let param = null;
    if ("object_ids" in action.payload && action.payload.object_ids.length) {
      this._oidCache.set(action.type, action.payload.object_ids);
    } else if (this._oidCache.has(action.type)) {
      action.payload.object_ids = this._oidCache.get(action.type);
    }
    const posKey = action.position ? `${action.position.x},${action.position.y}` : null;
    if (action.type === Action.SPECIAL) {
      name = action.payload.order;
    } else if (action.type === Action.GAME) {
      name = action.payload.command;
      if (name === "Speed") param = action.payload.speed;
    } else if (action.type === Action.STANCE) {
      name = "Stance";
      param = action.payload.stance;
    } else if (action.type === Action.FORMATION) {
      name = "Formation";
      param = action.payload.formation;
    } else if (action.type === Action.ORDER && this._gaia.has(action.payload.target_id)) {
      name = "Gather";
      param = this._gaia.get(action.payload.target_id);
    } else if (action.type === Action.ORDER && posKey !== null && this._buildings.has(posKey)) {
      name = "Target";
      param = this._buildings.get(posKey);
    } else if (action.type === Action.GATHER_POINT) {
      if (this._gaia.has(action.payload.target_id)) {
        param = this._gaia.get(action.payload.target_id);
      } else if (posKey !== null && this._buildings.has(posKey)) {
        if (action.payload.object_ids.length === 1
          && action.payload.object_ids[0] === action.payload.target_id) {
          name = "Spawn";
        }
        param = this._buildings.get(posKey);
      }
    } else if (action.type === Action.BUY || action.type === Action.SELL) {
      action.payload.amount *= 100;
    } else if (action.type === Action.BUILD) {
      param = action.payload.building;
      if (this._buildings.has(posKey)) {
        if (this._buildings.get(posKey) === "Farm" && action.payload.building === "Farm") {
          name = "Reseed";
        }
      }
      this._buildings.set(posKey, action.payload.building);
    } else if (action.type === Action.QUEUE || action.type === Action.DE_QUEUE) {
      param = action.payload.unit;
    } else if (action.type === Action.RESEARCH) {
      param = action.payload.technology;
    }
    const input = {
      timestamp: action.timestamp,
      type: name,
      param,
      payload: action.payload,
      player: action.player,
      position: action.position,
    };
    this.inputs.push(input);
    return input;
  }
}

/** Python's str.title(): capitalize each run of letters. */
function titleCase(text: string) {
  return text.replace(/[A-Za-z]+/g, (word: Rec) =>
    word[0].toUpperCase() + word.slice(1).toLowerCase());
}

/** Enrich action data with lookups. */
function enrichAction(action: Rec, actionData: Rec, dataset: Rec, consts: Rec) {
  if ("x" in actionData && "y" in actionData && actionData.x >= 0 && actionData.y >= 0) {
    if (action.type !== Action.SPECIAL || ("target_id" in actionData && actionData.target_id > 0)) {
      action.position = { x: actionData.x, y: actionData.y };
      delete action.payload.x;
      delete action.payload.y;
    }
  }
  const lookup = (table: Rec, key: Rec) => (key in table ? table[key] : null);
  if ("technology_id" in actionData) {
    action.payload.technology = lookup(dataset.technologies, String(actionData.technology_id));
  }
  if ("formation_id" in actionData) {
    action.payload.formation = lookup(consts.formations, String(actionData.formation_id));
  }
  if ("stance_id" in actionData) {
    action.payload.stance = lookup(consts.stances, String(actionData.stance_id));
  }
  if ("building_id" in actionData) {
    action.payload.building = lookup(dataset.objects, String(actionData.building_id));
  }
  if ("unit_id" in actionData) {
    action.payload.unit = lookup(dataset.objects, String(actionData.unit_id));
  }
  if ("command_id" in actionData) {
    action.payload.command = lookup(consts.commands, String(actionData.command_id));
  }
  if ("order_id" in actionData) {
    action.payload.order = lookup(consts.orders, String(actionData.order_id));
  }
  if ("resource_id" in actionData) {
    action.payload.resource = lookup(consts.resources, String(actionData.resource_id));
  }
}

function getDifficulty(data: Rec) {
  if (data.version === Version.HD) return data.hd.difficulty_id;
  if (data.version === Version.DE) return data.de.difficulty_id;
  return data.scenario.difficulty_id;
}

/*
 * The instructions block the game writes into every recording states the
 * settings in words, and it is the only trustworthy difficulty in a save-68
 * DE file: the header byte mgz reads is team_bonus_disabled, so it says
 * "Hardest" for every game. The label is localized, so this only recognizes
 * the English one and otherwise leaves the header value alone.
 */
const DIFFICULTY_LABELS = ["Difficulty Level", "Difficulty"];

/** Value of a `Label: value` line in the instructions, or null. */
function instructionsSetting(instructions: Rec, encoding: string, labels: Rec) {
  for (const line of splitLines(instructions)) {
    let text;
    try {
      text = decodeBytes(line, encoding);
    } catch (err) {
      continue;
    }
    const at = text.indexOf(":");
    if (at < 0) continue;
    if (!labels.includes(text.slice(0, at).trim())) continue;
    const value = text.slice(at + 1).trim();
    if (value) return value;
  }
  return null;
}

function getMapId(data: Rec) {
  if (data.version === Version.HD) return data.hd.map_id;
  if (data.version === Version.DE) return data.de.rms_map_id;
  return data.scenario.map_id;
}

/**
 * Parse a match.
 *
 * This is one big function because the dependency graph between the variables
 * is dense -- same as the Python.
 */
function parseMatch(input: RecordingInput, options: ParseOptions = {}): Match {
  const buf = toBytes(input);
  const handle = new Stream(buf);
  const data = parseHeader(handle, options);
  const bodyPos = handle.tell() - 4; // log version
  const consts = getConsts(options.reference);

  const [datasetId, dataset] = getDataset(data.version, data.mod, options.reference);
  const mapId = getMapId(data);
  let mapData;
  let encoding;
  let language;
  try {
    [mapData, encoding, language] = getMapData(
      mapId,
      data.scenario.instructions,
      data.map.dimension,
      data.version,
      datasetId,
      dataset,
      data.map.tiles,
      data.lobby.seed,
      consts.map_sizes,
      decodeBytes(data.scenario.scenario_filename, "utf-8"));
  } catch (err) {
    throw new Error(`could not get map data: ${(err as Rec).message}`);
  }

  // Handle DE-specific data
  let rated = null;
  const dePlayers = new Map();
  let lobby = null;
  let guid = null;
  if (data.de) {
    for (const player of data.de.players) dePlayers.set(player.number, player);
    lobby = data.de.lobby;
    guid = data.de.guid;
    rated = data.de.rated;
  }

  const makeObject = (obj: Rec) => ({
    name: String(obj.object_id) in dataset.objects ? dataset.objects[String(obj.object_id)] : null,
    class_id: obj.class_id,
    object_id: obj.object_id,
    instance_id: obj.instance_id,
    index: obj.index,
    position: { x: obj.position.x, y: obj.position.y },
  });

  // Parse gaia objects
  const gaia = data.players[0].objects.map(makeObject);

  const inputs = new Inputs(new Map(gaia.map((o: Rec) => [o.instance_id, o.name])));

  // Parse players
  const players = new Map();
  const allies = new Map();
  for (const player of data.players.slice(1)) {
    const set = new Set([player.number]);
    player.diplomacy.forEach((stance: Rec, i: Rec) => {
      if (stance === 2) set.add(i);
    });
    allies.set(player.number, set);
    const dePlayer = dePlayers.get(player.number);
    const merged = dePlayer ? { ...player, ...dePlayer } : player;
    let posX = null;
    let posY = null;
    for (const obj of merged.objects) {
      if (TC_IDS.includes(obj.object_id)) {
        posX = obj.position.x;
        posY = obj.position.y;
      }
    }
    players.set(merged.number, {
      number: merged.number,
      name: decodeBytes(merged.name, encoding),
      color: consts.player_colors[String(merged.color_id)],
      color_id: merged.color_id,
      civilization: dataset.civilizations[String(merged.civilization_id)].name,
      civilization_id: merged.civilization_id,
      position: { x: posX, y: posY },
      objects: merged.objects.map(makeObject),
      profile_id: merged.profile_id,
      timeseries: [],
      prefer_random: merged.prefer_random,
      handicap: "handicap" in merged ? merged.handicap : 100,
      team: null,
      team_id: null,
      winner: false,
      resigned: false,
      rate_snapshot: null,
      eapm: null,
    });
  }

  // Assign teams
  let teamIds;
  if (dePlayers.size) {
    const byTeam = new Map();
    for (const [number, player] of dePlayers) {
      let key = null;
      if (player.team_id > 1) key = player.team_id;
      else if (player.team_id === 1) key = number + 9;
      if (key === null) continue;
      if (!byTeam.has(key)) byTeam.set(key, []);
      byTeam.get(key).push(number);
    }
    teamIds = [...byTeam.values()];
  } else {
    const seen = new Set();
    teamIds = [];
    for (const set of allies.values()) {
      const key = [...set].sort((a, b) => a - b).join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      teamIds.push([...set]);
    }
  }
  const teams = [];
  for (const team of teamIds) {
    const t = team.map((x: Rec) => players.get(x));
    for (const x of team) {
      players.get(x).team = t;
      players.get(x).team_id = team;
    }
    teams.push(t);
  }

  // Compute diplomacy
  const diplomacyType = getDiplomacyType(teams, [...players.values()]);

  // Extract lobby chat
  const pd = [...players.entries()].map(([n, p]) => ({ name: p.name, number: n }));
  const chats = [];
  for (const c of data.lobby.chat) {
    const chat = parseChat(c, encoding, 0, pd, diplomacyType, "lobby");
    if (chat.type === Chat.DISCARD || !players.has(chat.player_number)) continue;
    chats.push({
      timestamp: chat.timestamp,
      message: chat.message,
      origination: chat.origination,
      audience: chat.audience,
      player: players.get(chat.player_number),
    });
    inputs.addChat(chats[chats.length - 1]);
  }

  // Parse player actions
  meta(handle);
  let timestamp = 0;
  const resigned = new Set();
  let recordedAchievements = null;
  const actions = [];
  const viewlocks = [];
  const uptimes = [];
  const eapm = new Map();
  let lastViewlock = null;
  for (;;) {
    let opType;
    let opData;
    try {
      [opType, opData] = operation(handle);
    } catch (err) {
      if (err instanceof EOFError) break;
      throw err;
    }
    if (opType === Operation.SYNC) {
      timestamp += opData[0];
      const statRow = opData[2];
      if (statRow && Object.keys(statRow).length) {
        for (const player of players.values()) {
          if (!(player.number in statRow)) continue;
          const stats = statRow[player.number];
          player.timeseries.push({
            timestamp: statRow.current_time,
            total_resources: stats.total_res,
            total_objects: stats.obj_count,
            // sync() already reads both; mgz.model drops them. dp_obj_count is
            // the displayable count -- objects plus shadows, corpses and
            // projectiles -- so dp/obj sits at ~2.0 with an all-villager
            // economy and climbs with the army. Appended, so the CLI's
            // three-column `series` rows are unchanged.
            dp_objects: stats.dp_obj_count,
            dp_ttl: stats.dp_obj_ttl,
          });
        }
      }
    } else if (opType === Operation.VIEWLOCK) {
      if (lastViewlock && opData[0] === lastViewlock[0] && opData[1] === lastViewlock[1]) continue;
      viewlocks.push({
        timestamp,
        position: { x: opData[0], y: opData[1] },
        player: players.get(data.metadata.owner_id),
      });
      lastViewlock = opData;
    } else if (opType === Operation.CHAT) {
      const chat = parseChat(opData, encoding, timestamp, pd, diplomacyType, "game");
      if (chat.type === Chat.MESSAGE) {
        chats.push({
          timestamp: chat.timestamp + data.map.restore_time,
          message: chat.message,
          origination: chat.origination,
          audience: chat.audience,
          player: players.get(chat.player_number),
        });
        inputs.addChat(chats[chats.length - 1]);
      }
      if (chat.type === Chat.AGE) {
        uptimes.push({
          timestamp: chat.timestamp + data.map.restore_time,
          age: chat.age,
          player: players.get(chat.player_number) || null,
        });
      }
    } else if (opType === Operation.ACTION) {
      const [actionType, actionData] = opData;
      const action = {
        timestamp,
        type: actionType,
        type_name: ACTION_NAMES[actionType],
        payload: actionData,
        player: null,
        position: null,
      };
      if (actionType === Action.RESIGN && players.has(actionData.player_id)) {
        const quitter = players.get(actionData.player_id);
        resigned.add(quitter);
        // On the player too, not just in the set: the set is consumed below to
        // work out who won, which is an inference. Who resigned is the thing
        // the recording actually says, and it is per player rather than per
        // team -- a teammate who played to the end did not resign.
        quitter.resigned = true;
      }
      if (actionType === Action.POSTGAME) {
        recordedAchievements = parseAchievements(actionData.bytes, encoding, consts);
      }
      if ("player_id" in actionData && players.has(actionData.player_id)) {
        if (!AI_ACTIONS.includes(actionType)) {
          eapm.set(actionData.player_id, (eapm.get(actionData.player_id) || 0) + 1);
        }
        action.player = players.get(actionData.player_id);
        delete action.payload.player_id;
      }
      enrichAction(action, actionData, dataset, consts);
      actions.push(action);
      inputs.addAction(action);
    } else if (opType === Operation.POSTGAME && opData && "leaderboards" in opData) {
      const byNumber = new Map(opData.leaderboards[0].players.map((x: Rec) => [x.number, x.rating]));
      for (const player of players.values()) {
        const rating = byNumber.get(player.number - 1);
        player.rate_snapshot = rating === undefined ? null : rating;
      }
    }
  }

  // Compute winner(s)
  /*
   * A game nobody resigned from is one the recording's owner walked out of.
   * The file stops where their client stopped writing it, and a client stops
   * because the player left -- so the absence of a RESIGN anywhere is itself
   * the owner conceding, and every other side won.
   *
   * Weaker than the resignation case, and deliberately so: the recording says
   * a RESIGN happened, while it only implies a quit. It is wrong for the one
   * game the owner won by razing the last enemy building, where the loser was
   * eliminated rather than resigning and nobody sent anything -- read as a
   * loss here. That trade is the point: those are rare, and leaving both
   * sides uncrowned made a win and an abandonment look identical.
   *
   * Needs an owner who is on a side. A recording that names none, or names
   * somebody the team assignment left out, falls back to crowning no one.
   */
  const owner = players.get(data.metadata.owner_id);
  const ownerQuit = resigned.size === 0 && owner !== undefined && owner.team !== null;
  for (const team of teams) {
    /* Team identity, not membership: `player.team` is the very array `teams`
       holds, so the owner's side is the one object comparison finds. */
    const winner = ownerQuit
      ? team !== owner.team
      : !team.some((player: Rec) => resigned.has(player));
    if (resigned.size || ownerQuit) for (const player of team) player.winner = winner;
  }

  // Compute eAPM
  for (const [playerId, actionCount] of eapm) {
    players.get(playerId).eapm = pyRound(actionCount / (timestamp / 1000 / 60));
  }

  // End-game achievements: the recorded score screen when the file has one,
  // otherwise what the body supports. See attachAchievements.
  attachAchievements([...players.values()], recordedAchievements, uptimes, actions);

  const speedFactor = Math.trunc(pyRoundTo(data.metadata.speed, 2) * 100);
  return {
    players: [...players.values()],
    teams,
    gaia,
    map: {
      id: mapId,
      name: mapData.name,
      /* A scenario rather than a random map, so the name above is a scenario's
         filename. `custom` is not the same question: a custom random map is
         custom too. */
      scenario: mapData.scenario,
      dimension: mapData.dimension,
      size: consts.map_sizes[String(mapData.dimension)],
      custom: mapData.custom,
      seed: mapData.seed,
      mod_id: data.version === Version.DE && mapData.custom ? data.de.rms_mod_id : null,
      zr: mapData.name.startsWith("ZR@"),
      modes: mapData.modes,
      tiles: mapData.tiles,
    },
    file: {
      encoding,
      language,
      size: buf.length,
      perspective: players.get(data.metadata.owner_id),
      viewlocks,
    },
    restored: data.map.restore_time > 0,
    restore_time: data.map.restore_time,
    speed: consts.speeds[String(speedFactor)],
    speed_id: speedFactor,
    cheats: data.metadata.cheats,
    // PORT: mgz takes these from the lobby block, which reads back all zeros on
    // save 68 -- population 0 and teams unlocked for a 200-pop, teams-locked
    // game. The DE header carries both, and its values match what the
    // recording's instructions block states in words.
    lock_teams: data.version === Version.DE ? data.de.lock_teams : data.lobby.lock_teams,
    population: data.version === Version.DE ? data.de.population_limit : data.lobby.population,
    chat: chats,
    guid,
    lobby,
    rated,
    dataset: dataset.dataset.name,
    /* The reference table has no name for every id the game writes -- a
       campaign mission reports 5, which is not in it -- and a payload field
       that is `undefined` reaches the report as the word "undefined". */
    type: consts.game_types[String(data.lobby.game_type_id)] ?? null,
    type_id: data.lobby.game_type_id,
    map_reveal: consts.map_reveal_choices[String(data.lobby.reveal_map_id)],
    map_reveal_id: data.lobby.reveal_map_id,
    difficulty: instructionsSetting(data.scenario.instructions, encoding, DIFFICULTY_LABELS)
      || consts.difficulties[String(getDifficulty(data))],
    difficulty_id: getDifficulty(data),
    starting_age: data.version === Version.DE
      ? consts.starting_ages[String(data.de.starting_age_id)] : null,
    team_together: data.version === Version.DE ? data.de.team_together : null,
    lock_speed: data.version === Version.DE ? data.de.lock_speed : null,
    all_technologies: data.version === Version.DE ? data.de.all_technologies : null,
    multiqueue: data.version === Version.DE ? true : null,
    duration: timestamp + data.map.restore_time,
    diplomacy_type: diplomacyType,
    completed: resigned.size > 0,
    dataset_id: datasetId,
    version: VERSION_NAMES[data.version],
    version_id: data.version,
    game_version: data.game_version,
    save_version: data.save_version,
    log_version: data.log_version,
    build: data.version === Version.DE ? data.de.build : null,
    timestamp: data.version === Version.DE && data.de.timestamp ? data.de.timestamp : null,
    spec_delay: data.version === Version.DE ? data.de.spec_delay : null,
    allow_specs: data.version === Version.DE ? data.de.allow_specs : null,
    hidden_civs: data.version === Version.DE ? data.de.hidden_civs : null,
    private: data.version === Version.DE ? data.de.visibility_id === 2 : null,
    actions,
    inputs: inputs.inputs,
    uptimes,
    // The recorded score screen, or null when the file carries none (all DE
    // recordings). Per-player figures live on player.achievements either way.
    achievements: recordedAchievements,
    body_pos: bodyPos,
    // The raw DE header block, which filter_events reads for AI persona, slot
    // type, and handicap. Kept here so callers need not parse the file twice.
    de: data.de,
  };
}

/* ------------------------------------------------------------------ */
/* parse_rec.py                                                        */
/* ------------------------------------------------------------------ */

/** Durations and timestamps are milliseconds here; Python uses timedelta. */
function fmtDuration(ms: Rec) {
  const total = Math.trunc(ms / 1000);
  const h = Math.floor(total / 3600);
  const rem = total % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function fmtTimestamp(ms: Rec) {
  const total = Math.trunc(ms / 1000);
  const h = Math.floor(total / 3600);
  const rem = total % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function displayName(player: Rec) {
  return player.name || `AI (P${player.number})`;
}

/** Python's datetime.fromtimestamp(...) rendered by str(). */
function fmtPlayedAt(epochSeconds: Rec) {
  const d = new Date(epochSeconds * 1000);
  const pad = (v: Rec) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Counter.most_common: highest count first, insertion order breaking ties. */
function mostCommon(counter: Rec, limit: number) {
  const entries = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  return limit === undefined ? entries : entries.slice(0, limit);
}

function counterTotal(counter: Rec) {
  let total = 0;
  for (const value of counter.values()) total += value;
  return total;
}

const INTERESTING_PAYLOAD_KEYS = [
  "technology", "unit", "building", "formation", "stance", "amount", "resource",
];

function buildReport(
  match: Match,
  { showChat = true, showActions = false }: { showChat?: boolean; showActions?: boolean } = {},
): string {
  const lines: string[] = [];
  const add = (line = "") => lines.push(line);

  add("=".repeat(60));
  add("GAME SUMMARY");
  add("=".repeat(60));
  add(`Game version : ${match.version || "Unknown"} ${match.game_version || ""} ${
    match.save_version === null || match.save_version === undefined
      ? "" : pyFloatStr(match.save_version)}`);
  add(`Map          : ${match.map.name} (${match.map.dimension}x${match.map.dimension})`);
  add(`Game type    : ${match.type ?? `Unknown (${match.type_id})`}`);
  add(`Difficulty   : ${match.difficulty}`);
  add(`Speed        : ${match.speed}`);
  add(`Population   : ${match.population}`);
  add(`Duration     : ${fmtDuration(match.duration)}`);
  if (match.timestamp) add(`Played at    : ${fmtPlayedAt(match.timestamp)}`);

  add("");
  add("=".repeat(60));
  add("PLAYERS");
  add("=".repeat(60));
  const teams = new Map();
  match.teams.forEach((team: Rec, idx: Rec) => {
    for (const p of team) teams.set(p.number, idx + 1);
  });
  for (const p of match.players) {
    const result = p.winner ? "WINNER" : "defeated";
    const teamNo = teams.has(p.number) ? teams.get(p.number) : "-";
    add(`  P${p.number} ${displayName(p)}`);
    add(`      Civilization : ${p.civilization}`);
    add(`      Team         : ${teamNo}`);
    add(`      Color        : ${p.color}`);
    if (p.rate_snapshot) add(`      Rating       : ${p.rate_snapshot}`);
    add(`      Result       : ${result}`);
    if (p.eapm) add(`      eAPM         : ${p.eapm}`);
    add("");
  }

  if (showChat && match.chat.length) {
    add("=".repeat(60));
    add("CHAT");
    add("=".repeat(60));
    for (const msg of match.chat) {
      const who = msg.player ? displayName(msg.player) : "System";
      add(`  [${fmtTimestamp(msg.timestamp)}] ${who}: ${msg.message}`);
    }
    add("");
  }

  add("=".repeat(60));
  add("ACTION STATISTICS");
  add("=".repeat(60));
  const perPlayer = new Map();
  for (const p of match.players) perPlayer.set(p.number, new Map());
  const totals = new Map();
  for (const action of match.actions) {
    const name = action.type_name;
    totals.set(name, (totals.get(name) || 0) + 1);
    if (action.player && perPlayer.has(action.player.number)) {
      const counter = perPlayer.get(action.player.number);
      counter.set(name, (counter.get(name) || 0) + 1);
    }
  }

  add(`  Total actions: ${counterTotal(totals)}`);
  add("");
  add("  Top action types:");
  for (const [name, count] of mostCommon(totals, 15)) {
    add(`    ${padRight(name, 20)} ${count}`);
  }
  add("");
  for (const p of match.players) {
    const counts = perPlayer.get(p.number);
    add(`  ${displayName(p)}: ${counterTotal(counts)} actions`);
    for (const [name, count] of mostCommon(counts, 5)) {
      add(`    ${padRight(name, 20)} ${count}`);
    }
    add("");
  }

  if (showActions) {
    add("=".repeat(60));
    add("ACTION LOG");
    add("=".repeat(60));
    for (const action of match.actions) {
      const who = action.player ? displayName(action.player) : "-";
      const name = action.type_name;
      let detail = "";
      if (action.payload && Object.keys(action.payload).length) {
        const interesting = Object.entries(action.payload)
          .filter(([k]) => INTERESTING_PAYLOAD_KEYS.includes(k));
        if (interesting.length) {
          detail = "  " + interesting.map(([k, v]) => `${k}=${pyValueStr(v)}`).join(", ");
        }
      }
      add(`  [${fmtTimestamp(action.timestamp)}] ${padRight(who, 20)} ${name}${detail}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse a recording and return the parse_rec.py report as a string.
 *
 * @param {Uint8Array|ArrayBuffer|string} input recording bytes, or a path (Node)
 * @param {object} [options]
 * @param {boolean} [options.chat=true]     include chat messages
 * @param {boolean} [options.actions=false] include the full action log
 * @param {object}  [options.reference]     {constants, datasets} override
 */
function parseRec(input: RecordingInput, options: ParseRecOptions = {}): string {
  const match = parseMatch(input, options);
  return buildReport(match, {
    showChat: options.chat !== false,
    showActions: Boolean(options.actions),
  });
}

/**
 * parseMatch for environments without a synchronous inflate.
 *
 * The browser only offers DecompressionStream, which is async, so inflate the
 * header first and hand the result to the otherwise-synchronous parser. In Node
 * this just awaits the sync path.
 */
async function parseMatchAsync(input: RecordingInput, options: ParseOptions = {}): Promise<Match> {
  const buf = toBytes(input);
  if (runtime.zlib || options.inflatedHeader) return parseMatch(buf, options);
  const [start, end] = headerRange(buf);
  const inflatedHeader = await inflateRaw(buf.subarray(start, end));
  return parseMatch(buf, { ...options, inflatedHeader });
}

/** parseRec for environments without a synchronous inflate. */
async function parseRecAsync(input: RecordingInput, options: ParseRecOptions = {}): Promise<string> {
  const match = await parseMatchAsync(input, options);
  return buildReport(match, {
    showChat: options.chat !== false,
    showActions: Boolean(options.actions),
  });
}

export {
  parseRec,
  parseRecAsync,
  parseMatch,
  parseMatchAsync,
  buildReport,
  parseHeader,
  parseAchievements,
  headerRange,
  inflateRaw,
  Stream,
  displayName,
  fmtDuration,
  fmtTimestamp,
  Action,
  ACTION_NAMES,
  Version,
};
