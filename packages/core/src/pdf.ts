import type { ByteSource } from "./bytes.js";

/**
 * A minimal read-only PDF reader, written over {@link ByteSource} for the same
 * reason {@link ./zip.ts} is: the sync CLI holds a whole book in memory, and a
 * reader in the app would pull a few objects out of a 40 MB file over ranged
 * reads. Only what metadata extraction needs is implemented, but that turns out
 * to be most of the document skeleton — a PDF hides its own catalog behind a
 * cross-reference table, and since PDF 1.5 often inside a compressed stream.
 *
 * What is here: the cross-reference table in both its forms, object streams,
 * Flate with PNG predictors, and enough of the object grammar to walk from the
 * trailer to the document information dictionary. Page content, fonts and
 * graphics are not read at all.
 *
 * What is deliberately not here is decryption. A PDF encrypted with an empty
 * user password — the permissions-only encryption publishers apply — has
 * readable structure but encrypted strings, so its metadata comes back empty
 * rather than as mojibake, and {@link PdfMetadata.encrypted} says why.
 */

/** Values a PDF object can hold, as far as this reader is concerned. */
export type PdfValue =
  | null
  | boolean
  | number
  | { kind: "name"; value: string }
  | { kind: "string"; bytes: Uint8Array }
  | { kind: "ref"; num: number; gen: number }
  | { kind: "stream"; dict: PdfDict; offset: number }
  | PdfValue[]
  | PdfDict;

/** A dictionary, keyed by name without its leading slash. */
export type PdfDict = Map<string, PdfValue>;

export type PdfMetadata = {
  /**
   * The document information dictionary, text-decoded. Dates are left exactly
   * as recorded, in PDF's own format — see {@link pdfDate}.
   */
  info: Record<string, string>;

  /** The XMP packet from the catalog's `/Metadata` stream, as text. */
  xmp: string | null;

  /** Pages, from the page tree root. Null when the tree is unreadable. */
  pages: number | null;

  /**
   * Whether the document is encrypted, and so whether the emptiness of
   * everything above should be read as "not recorded" or as "not readable".
   */
  encrypted: boolean;
};

/** Bytes that end a token without being part of one. */
const DELIMITERS = new Set([
  0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25,
]);

function isWhite(byte: number): boolean {
  return (
    byte === 0x20 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x09 ||
    byte === 0x0c ||
    byte === 0x00
  );
}

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

function isRegular(byte: number): boolean {
  return !isWhite(byte) && !DELIMITERS.has(byte);
}

/**
 * Thrown when a parse runs off the end of the window it was given, which is a
 * request for more bytes rather than a malformed file. Object sizes are not
 * recorded anywhere in a PDF, so a window is always a guess, and growing it on
 * this is how the guess gets corrected.
 */
class Truncated extends Error {}

/**
 * A parse position within one window of bytes.
 *
 * `complete` says whether the window is the whole of what there is to read.
 * It matters because running out of bytes means two different things: over a
 * window it is a request for a larger one, and over an object stream — which is
 * decompressed whole and whose last member ends at the last byte — it is
 * simply the end. Without the distinction every object stream loses its final
 * object, which since PDF 1.5 is usually where the metadata lives.
 */
type Lexer = { bytes: Uint8Array; pos: number; complete: boolean };

/** Sentinel for the `]` and `>>` that close a container. */
const CLOSE = Symbol("close");

function byteAt(lexer: Lexer, offset = 0): number {
  const index = lexer.pos + offset;
  if (index >= lexer.bytes.length) throw new Truncated();
  return lexer.bytes[index];
}

function skipSpace(lexer: Lexer): void {
  for (;;) {
    while (lexer.pos < lexer.bytes.length && isWhite(lexer.bytes[lexer.pos])) {
      lexer.pos++;
    }
    if (lexer.pos >= lexer.bytes.length) {
      if (lexer.complete) return;
      throw new Truncated();
    }
    // A comment runs to the end of the line and counts as whitespace.
    if (lexer.bytes[lexer.pos] !== 0x25) return;
    while (
      lexer.pos < lexer.bytes.length &&
      lexer.bytes[lexer.pos] !== 0x0a &&
      lexer.bytes[lexer.pos] !== 0x0d
    ) {
      lexer.pos++;
    }
  }
}

/** The next run of regular characters, as ASCII. Empty at a delimiter. */
function readToken(lexer: Lexer): string {
  const start = lexer.pos;
  while (lexer.pos < lexer.bytes.length && isRegular(lexer.bytes[lexer.pos])) {
    lexer.pos++;
  }
  // A token running to the last byte may have been cut in half, unless this
  // window is all there is.
  if (lexer.pos === lexer.bytes.length && !lexer.complete) {
    throw new Truncated();
  }
  return String.fromCharCode(...lexer.bytes.subarray(start, lexer.pos));
}

/** `/Name`, with `#xx` escapes resolved. */
function readName(lexer: Lexer): string {
  lexer.pos++;
  const token = readToken(lexer);
  return token.replace(/#([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const ESCAPES: Record<number, number> = {
  110: 0x0a, // n
  114: 0x0d, // r
  116: 0x09, // t
  98: 0x08, // b
  102: 0x0c, // f
};

/** A literal string: `(…)`, which nests and escapes with a backslash. */
function readLiteralString(lexer: Lexer): Uint8Array {
  lexer.pos++;
  const out: number[] = [];
  let depth = 1;

  for (;;) {
    const byte = byteAt(lexer);
    lexer.pos++;

    if (byte === 0x5c) {
      const next = byteAt(lexer);
      lexer.pos++;

      if (next in ESCAPES) {
        out.push(ESCAPES[next]);
      } else if (next >= 0x30 && next <= 0x37) {
        // Up to three octal digits.
        let code = next - 0x30;
        for (let i = 0; i < 2; i++) {
          const digit = byteAt(lexer);
          if (digit < 0x30 || digit > 0x37) break;
          code = code * 8 + (digit - 0x30);
          lexer.pos++;
        }
        out.push(code & 0xff);
      } else if (next === 0x0a) {
        // A backslash at end of line continues the string.
      } else if (next === 0x0d) {
        if (byteAt(lexer) === 0x0a) lexer.pos++;
      } else {
        out.push(next);
      }
      continue;
    }

    if (byte === 0x28) depth++;
    if (byte === 0x29) {
      depth--;
      if (depth === 0) break;
    }
    out.push(byte);
  }

  return new Uint8Array(out);
}

/** A hex string: `<…>`, whitespace-tolerant, an odd final digit padded. */
function readHexString(lexer: Lexer): Uint8Array {
  lexer.pos++;
  const digits: number[] = [];

  for (;;) {
    const byte = byteAt(lexer);
    lexer.pos++;
    if (byte === 0x3e) break;
    if (isWhite(byte)) continue;

    const digit = Number.parseInt(String.fromCharCode(byte), 16);
    if (Number.isNaN(digit)) continue;
    digits.push(digit);
  }

  if (digits.length % 2 === 1) digits.push(0);

  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = digits[i * 2] * 16 + digits[i * 2 + 1];
  }
  return out;
}

/**
 * Parses one object. `base` is where the window sits in the source, which is
 * what lets a stream record an absolute offset for its data.
 */
function parseValue(lexer: Lexer, base: number): PdfValue | typeof CLOSE {
  skipSpace(lexer);
  const byte = byteAt(lexer);

  if (byte === 0x2f) return { kind: "name", value: readName(lexer) };
  if (byte === 0x28) return { kind: "string", bytes: readLiteralString(lexer) };

  if (byte === 0x5b) {
    lexer.pos++;
    const items: PdfValue[] = [];
    for (;;) {
      const item = parseValue(lexer, base);
      if (item === CLOSE) return items;
      items.push(item);
    }
  }

  if (byte === 0x5d) {
    lexer.pos++;
    return CLOSE;
  }

  if (byte === 0x3c) {
    if (byteAt(lexer, 1) !== 0x3c) {
      return { kind: "string", bytes: readHexString(lexer) };
    }
    lexer.pos += 2;
    return parseDictionary(lexer, base);
  }

  if (byte === 0x3e) {
    // `>>`, closing a dictionary.
    lexer.pos += 2;
    return CLOSE;
  }

  if (isDigit(byte) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
    const start = lexer.pos;
    const token = readToken(lexer);
    const value = Number.parseFloat(token);

    // `N G R` is an indirect reference, and only a lookahead distinguishes it
    // from three separate numbers in an array.
    if (Number.isInteger(value) && value >= 0 && !token.includes(".")) {
      const rewind = lexer.pos;
      try {
        skipSpace(lexer);
        const generation = readToken(lexer);
        if (/^\d+$/.test(generation)) {
          skipSpace(lexer);
          if (byteAt(lexer) === 0x52 && !isRegular(byteAt(lexer, 1))) {
            lexer.pos++;
            return {
              kind: "ref",
              num: value,
              gen: Number.parseInt(generation, 10),
            };
          }
        }
      } catch (error) {
        // Running out of window while looking ahead is only fatal if the
        // number itself was cut off; otherwise the number stands.
        if (error instanceof Truncated && rewind >= lexer.bytes.length)
          throw error;
      }
      lexer.pos = rewind;
    }

    if (Number.isNaN(value)) {
      // Not a number after all — a broken token. Treat as null rather than
      // derailing the whole object.
      lexer.pos = start + 1;
      return null;
    }
    return value;
  }

  const keyword = readToken(lexer);
  if (keyword === "true") return true;
  if (keyword === "false") return false;
  if (keyword === "null") return null;
  if (keyword === "") {
    // An unexpected delimiter. Step over it so a malformed object cannot spin.
    lexer.pos++;
    return null;
  }
  // `endobj`, `stream`, `R` on its own, or anything else unrecognised: the
  // caller decides what to do with where we stopped.
  lexer.pos -= keyword.length;
  return CLOSE;
}

function parseDictionary(lexer: Lexer, base: number): PdfDict | PdfValue {
  const dict: PdfDict = new Map();

  for (;;) {
    skipSpace(lexer);
    if (byteAt(lexer) === 0x3e) {
      lexer.pos += 2;
      break;
    }
    if (byteAt(lexer) !== 0x2f) {
      // A key that is not a name means the dictionary is malformed. Keep what
      // was read rather than losing the object.
      const stray = parseValue(lexer, base);
      if (stray === CLOSE) break;
      continue;
    }

    const key = readName(lexer);
    const value = parseValue(lexer, base);
    if (value === CLOSE) break;
    dict.set(key, value);
  }

  // A dictionary followed by `stream` is a stream object, and its data starts
  // after the end-of-line that must follow the keyword.
  const rewind = lexer.pos;
  try {
    skipSpace(lexer);
    if (readToken(lexer) === "stream") {
      if (byteAt(lexer) === 0x0d) lexer.pos++;
      if (byteAt(lexer) === 0x0a) lexer.pos++;
      return { kind: "stream", dict, offset: base + lexer.pos };
    }
  } catch (error) {
    if (!(error instanceof Truncated)) throw error;
    // The bytes ended right after the dictionary. Over a window, whether
    // `stream` follows is unknown and worth a larger one; over a complete
    // buffer there is nothing more to come and the dictionary stands.
    if (!lexer.complete) throw error;
  }
  lexer.pos = rewind;

  return dict;
}

/** How much to read when the size of what is being read cannot be known. */
const WINDOW_SIZES = [4096, 65536, 1 << 20];

/**
 * Reads a window at `offset`, growing it while `parse` says it was cut short.
 * Returns null once even the largest window does not help, or once the window
 * has reached the end of the source and growing it cannot add anything.
 */
async function withWindow<T>(
  source: ByteSource,
  offset: number,
  parse: (lexer: Lexer, base: number) => T,
): Promise<T | null> {
  for (const size of WINDOW_SIZES) {
    const bytes = await source.read(offset, size);
    if (!bytes) return null;

    // Short of what was asked for means the source ended, not the window, so
    // there is no larger window to grow into.
    const complete = bytes.length < size;

    try {
      return parse({ bytes, pos: 0, complete }, offset);
    } catch (error) {
      if (!(error instanceof Truncated) || complete) return null;
    }
  }
  return null;
}

const encoder = new TextEncoder();

/** Where an object lives: at a file offset, or inside an object stream. */
type Location =
  | { at: "offset"; offset: number }
  | { at: "stream"; stream: number; index: number };

type Xref = { entries: Map<number, Location>; trailer: PdfDict };

/**
 * Finds the byte offset of some ASCII within a window, searching backwards.
 * Used for the keywords that are located relative to the end of the file.
 */
function lastIndexOfAscii(haystack: Uint8Array, needle: string): number {
  const target = encoder.encode(needle);
  outer: for (let i = haystack.length - target.length; i >= 0; i--) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfAscii(haystack: Uint8Array, needle: string, from = 0): number {
  const target = encoder.encode(needle);
  outer: for (let i = from; i <= haystack.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (haystack[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * The tail to search for `startxref`. The spec puts it within a few dozen bytes
 * of the end; the allowance is for files with trailing junk, which exist.
 */
const TAIL_SIZE = 4096;

async function readStartXref(source: ByteSource): Promise<number | null> {
  const total = await source.size();
  const size = Math.min(total, TAIL_SIZE);
  const tail = await source.read(total - size, size);
  if (!tail) return null;

  const at = lastIndexOfAscii(tail, "startxref");
  if (at === -1) return null;

  const lexer: Lexer = {
    bytes: tail,
    pos: at + "startxref".length,
    complete: true,
  };
  try {
    skipSpace(lexer);
    const offset = Number.parseInt(readToken(lexer), 10);
    return Number.isInteger(offset) && offset >= 0 && offset < total
      ? offset
      : null;
  } catch {
    return null;
  }
}

export class PdfReader {
  private readonly objects = new Map<number, Location>();
  private trailer: PdfDict = new Map();
  private readonly cache = new Map<number, PdfValue>();
  private readonly streams = new Map<number, Map<number, PdfValue>>();
  /** Set once a full-file scan has been done, so it happens at most once. */
  private recovered = false;

  private constructor(private readonly source: ByteSource) {}

  /**
   * Opens a document by walking its cross-reference chain. Null when the source
   * is not a PDF at all; a PDF whose chain is broken still opens, and recovers
   * by scanning when something cannot be found.
   */
  static async open(source: ByteSource): Promise<PdfReader | null> {
    // The header may be preceded by junk, which is why this is a search rather
    // than a comparison at zero.
    const head = await source.read(0, 1024);
    if (!head || indexOfAscii(head, "%PDF-") === -1) return null;

    const reader = new PdfReader(source);
    await reader.loadXref();
    return reader;
  }

  /** The trailer, merged across the chain. */
  get trailerDict(): PdfDict {
    return this.trailer;
  }

  private async loadXref(): Promise<void> {
    let offset = await readStartXref(this.source);
    const seen = new Set<number>();

    // Oldest sections are read last and never overwrite a newer entry, which is
    // what makes an incrementally updated file resolve to its latest objects.
    while (offset !== null && !seen.has(offset)) {
      seen.add(offset);
      const section = await this.readXrefSection(offset);
      if (!section) break;

      for (const [num, location] of section.entries) {
        if (!this.objects.has(num)) this.objects.set(num, location);
      }
      for (const [key, value] of section.trailer) {
        if (!this.trailer.has(key)) this.trailer.set(key, value);
      }

      // A hybrid-reference file keeps its compressed objects in a stream the
      // classic table points at, so both halves have to be read.
      const hybrid = section.trailer.get("XRefStm");
      if (typeof hybrid === "number" && !seen.has(hybrid)) {
        seen.add(hybrid);
        const extra = await this.readXrefSection(hybrid);
        for (const [num, location] of extra?.entries ?? []) {
          if (!this.objects.has(num)) this.objects.set(num, location);
        }
      }

      const prev = section.trailer.get("Prev");
      offset = typeof prev === "number" && prev !== offset ? prev : null;
      // `Prev` is per-section, and the merged trailer must not carry the one
      // from a section already followed.
      this.trailer.delete("Prev");
      this.trailer.delete("XRefStm");
    }

    // No catalog means the chain was unusable — a missing or wrong `startxref`,
    // a file with something prepended to it, a truncated download. Nothing has
    // asked for an object yet, so nothing would otherwise trigger the scan that
    // can still find one.
    if (!this.trailer.has("Root")) await this.recover();
  }

  private async readXrefSection(offset: number): Promise<Xref | null> {
    const head = await this.source.read(offset, 32);
    if (!head) return null;

    const lexer: Lexer = { bytes: head, pos: 0, complete: true };
    try {
      skipSpace(lexer);
    } catch {
      return null;
    }

    if (indexOfAscii(head, "xref", lexer.pos) === lexer.pos) {
      return this.readXrefTable(offset + lexer.pos + 4);
    }
    return this.readXrefStream(offset);
  }

  /**
   * The classic table: subsections of fixed-width entries, then `trailer`.
   *
   * Its length is not recorded anywhere, so the window grows until the trailer
   * is inside it — a 448-page book runs to some 80 KB of entries.
   */
  private async readXrefTable(offset: number): Promise<Xref | null> {
    return withWindow(this.source, offset, (lexer, base) => {
      const entries = new Map<number, Location>();

      for (;;) {
        skipSpace(lexer);
        const token = readToken(lexer);
        if (token === "trailer") break;

        const start = Number.parseInt(token, 10);
        skipSpace(lexer);
        const count = Number.parseInt(readToken(lexer), 10);
        if (!Number.isInteger(start) || !Number.isInteger(count)) {
          throw new Error("malformed xref subsection");
        }

        for (let i = 0; i < count; i++) {
          skipSpace(lexer);
          const position = Number.parseInt(readToken(lexer), 10);
          skipSpace(lexer);
          readToken(lexer); // generation
          skipSpace(lexer);
          const type = readToken(lexer);

          const num = start + i;
          if (type === "n" && !entries.has(num)) {
            entries.set(num, { at: "offset", offset: position });
          }
        }
      }

      const trailer = parseValue(lexer, base);
      return {
        entries,
        trailer: trailer instanceof Map ? trailer : new Map(),
      };
    });
  }

  /** The PDF 1.5 form: the table is itself a stream of binary entries. */
  private async readXrefStream(offset: number): Promise<Xref | null> {
    const parsed = await this.parseObjectAt(offset);
    const value = parsed?.value;
    if (!value || typeof value !== "object" || !("kind" in value)) return null;
    if (value.kind !== "stream") return null;

    const data = await this.streamBytes(value);
    if (!data) return null;

    const dict = value.dict;
    const widths = dict.get("W");
    if (!Array.isArray(widths)) return null;
    const [typeWidth, secondWidth, thirdWidth] = widths.map((w) =>
      typeof w === "number" ? w : 0,
    );
    const rowSize = typeWidth + secondWidth + thirdWidth;
    if (rowSize <= 0) return null;

    const size = dict.get("Size");
    const index = dict.get("Index");
    const ranges: number[][] = Array.isArray(index)
      ? index
          .map((n) => (typeof n === "number" ? n : 0))
          .reduce<number[][]>((pairs, n, i) => {
            if (i % 2 === 0) pairs.push([n, 0]);
            else pairs[pairs.length - 1][1] = n;
            return pairs;
          }, [])
      : [[0, typeof size === "number" ? size : 0]];

    const entries = new Map<number, Location>();
    let cursor = 0;

    const field = (start: number, width: number, fallback: number): number => {
      if (width === 0) return fallback;
      let value = 0;
      for (let i = 0; i < width; i++) value = value * 256 + data[start + i];
      return value;
    };

    for (const [start, count] of ranges) {
      for (let i = 0; i < count; i++) {
        if (cursor + rowSize > data.length) break;

        // A width of zero for the type field means type 1, per the spec.
        const type = field(cursor, typeWidth, 1);
        const second = field(cursor + typeWidth, secondWidth, 0);
        const third = field(cursor + typeWidth + secondWidth, thirdWidth, 0);
        cursor += rowSize;

        const num = start + i;
        if (entries.has(num)) continue;
        if (type === 1) entries.set(num, { at: "offset", offset: second });
        else if (type === 2) {
          entries.set(num, { at: "stream", stream: second, index: third });
        }
      }
    }

    return { entries, trailer: dict };
  }

  /**
   * Reads the indirect object at a byte offset, checking that the object found
   * there is the one expected.
   *
   * Offsets in the wild are often a few bytes out — a file with something
   * prepended shifts every one of them — so a header that does not parse where
   * it should is looked for nearby before giving up.
   */
  private async parseObjectAt(
    offset: number,
    expected?: number,
  ): Promise<{ num: number; value: PdfValue } | null> {
    const parse = (lexer: Lexer, base: number) => {
      skipSpace(lexer);
      const num = Number.parseInt(readToken(lexer), 10);
      skipSpace(lexer);
      readToken(lexer); // generation
      skipSpace(lexer);
      if (readToken(lexer) !== "obj") throw new Error("not an indirect object");
      if (!Number.isInteger(num)) throw new Error("no object number");

      const value = parseValue(lexer, base);
      return { num, value: value === CLOSE ? null : value };
    };

    const direct = await withWindow(this.source, offset, parse);
    if (direct && (expected === undefined || direct.num === expected)) {
      return direct;
    }

    if (expected === undefined) return direct;

    // Search a window around the offset for the header that should be there.
    const slack = 1024;
    const from = Math.max(0, offset - slack);
    const around = await this.source.read(from, slack * 2);
    if (!around) return null;

    const at = indexOfAscii(around, `${expected} `);
    if (at === -1) return null;

    const check: Lexer = { bytes: around, pos: at, complete: true };
    try {
      readToken(check);
      skipSpace(check);
      readToken(check);
      skipSpace(check);
      if (readToken(check) !== "obj") return null;
    } catch {
      return null;
    }

    const found = await withWindow(this.source, from + at, parse);
    return found?.num === expected ? found : null;
  }

  /** Resolves a value if it is a reference, and leaves it alone otherwise. */
  async resolve(value: PdfValue | undefined): Promise<PdfValue> {
    let current: PdfValue = value ?? null;
    // A reference to a reference is legal; a cycle of them is not, and a depth
    // limit is cheaper than tracking what has been seen.
    for (let depth = 0; depth < 8; depth++) {
      if (
        !current ||
        typeof current !== "object" ||
        !("kind" in current) ||
        current.kind !== "ref"
      ) {
        return current;
      }
      current = await this.object(current.num);
    }
    return null;
  }

  /** One object by number, from wherever the cross-reference table says. */
  async object(num: number): Promise<PdfValue> {
    const cached = this.cache.get(num);
    if (cached !== undefined) return cached;

    let value = await this.locate(num);
    if (value === null && !this.recovered) {
      // The table was wrong about this object. A full scan is the last resort,
      // and it is what makes a file with a damaged table still readable.
      await this.recover();
      value = await this.locate(num);
    }

    this.cache.set(num, value);
    return value;
  }

  private async locate(num: number): Promise<PdfValue> {
    const location = this.objects.get(num);
    if (!location) return null;

    if (location.at === "offset") {
      const parsed = await this.parseObjectAt(location.offset, num);
      return parsed?.value ?? null;
    }

    const contents = await this.objectStream(location.stream);
    return contents?.get(num) ?? null;
  }

  /**
   * Parses an object stream, which holds many small objects Flate-compressed
   * together — since PDF 1.5 the catalog and the information dictionary are
   * usually in one, which is why a reader that only scans raw bytes finds
   * neither.
   */
  private async objectStream(
    num: number,
  ): Promise<Map<number, PdfValue> | null> {
    const cached = this.streams.get(num);
    if (cached) return cached;

    const container = await this.resolve({ kind: "ref", num, gen: 0 });
    if (
      !container ||
      typeof container !== "object" ||
      !("kind" in container) ||
      container.kind !== "stream"
    ) {
      return null;
    }

    const data = await this.streamBytes(container);
    if (!data) return null;

    const count = await this.resolve(container.dict.get("N"));
    const first = await this.resolve(container.dict.get("First"));
    if (typeof count !== "number" || typeof first !== "number") return null;

    // The header is `objnum offset` pairs, all of them before any object data.
    const header: Lexer = { bytes: data, pos: 0, complete: true };
    const pairs: { num: number; offset: number }[] = [];
    try {
      for (let i = 0; i < count; i++) {
        skipSpace(header);
        const objectNumber = Number.parseInt(readToken(header), 10);
        skipSpace(header);
        const offset = Number.parseInt(readToken(header), 10);
        if (!Number.isInteger(objectNumber) || !Number.isInteger(offset)) break;
        pairs.push({ num: objectNumber, offset });
      }
    } catch {
      // A truncated header still yields the pairs already read.
    }

    const contents = new Map<number, PdfValue>();
    for (const pair of pairs) {
      const lexer: Lexer = {
        bytes: data,
        pos: first + pair.offset,
        complete: true,
      };
      if (lexer.pos >= data.length) continue;
      try {
        const value = parseValue(lexer, 0);
        contents.set(pair.num, value === CLOSE ? null : value);
      } catch {
        // One unparseable member does not spoil the stream.
      }
    }

    this.streams.set(num, contents);
    return contents;
  }

  /**
   * Reads and decodes a stream's data.
   *
   * `/Length` is often an indirect reference, and is sometimes simply wrong, so
   * a search for `endstream` backs it up.
   */
  async streamBytes(stream: {
    dict: PdfDict;
    offset: number;
  }): Promise<Uint8Array<ArrayBuffer> | null> {
    const declared = await this.resolve(stream.dict.get("Length"));
    let raw: Uint8Array<ArrayBuffer> | null = null;

    if (typeof declared === "number" && declared > 0) {
      raw = await this.source.read(stream.offset, declared);

      // A declared length is believed only when `endstream` is where it says
      // the data ends — allowing for the end-of-line in front of it, and a
      // little slack for writers that add a space. Not finding the keyword at
      // all is the case that matters: a length that is simply wrong points
      // into the middle of the data, and inflating that half yields nothing.
      const after = await this.source.read(stream.offset + declared, 32);
      const at = after ? indexOfAscii(after, "endstream") : -1;
      if (at < 0 || at > 4) raw = null;
    }

    if (!raw) {
      raw = await this.readUntilEndstream(stream.offset);
    }
    if (!raw) return null;

    return this.decode(raw, stream.dict);
  }

  /** Reads forward for the `endstream` that must close the data. */
  private async readUntilEndstream(
    offset: number,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    // Grows until the keyword is inside the block, which for a book-sized image
    // stream can take a few rounds. Capped so a file missing the keyword
    // entirely cannot turn into an unbounded read.
    for (let size = 1 << 16; size <= 1 << 26; size *= 4) {
      const block = await this.source.read(offset, size);
      if (!block) return null;

      const at = indexOfAscii(block, "endstream");
      if (at !== -1) {
        // The end-of-line in front of `endstream` is not part of the data.
        let end = at;
        if (end > 0 && block[end - 1] === 0x0a) end--;
        if (end > 0 && block[end - 1] === 0x0d) end--;
        return block.subarray(0, end) as Uint8Array<ArrayBuffer>;
      }

      // The source ended without the keyword, so what was read is all of it.
      if (block.length < size) return block;
    }
    return null;
  }

  private async decode(
    raw: Uint8Array<ArrayBuffer>,
    dict: PdfDict,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    const filter = await this.resolve(dict.get("Filter"));
    const filters = (Array.isArray(filter) ? filter : [filter]).filter(
      (f): f is { kind: "name"; value: string } =>
        !!f && typeof f === "object" && "kind" in f && f.kind === "name",
    );
    if (filters.length === 0) return raw;

    const parms = await this.resolve(dict.get("DecodeParms"));
    const parmsList = Array.isArray(parms) ? parms : [parms];

    let data = raw;
    for (const [i, entry] of filters.entries()) {
      if (entry.value !== "FlateDecode" && entry.value !== "Fl") {
        // Image and ASCII filters are not needed for anything read here, and a
        // stream behind one is better reported missing than mis-decoded.
        return null;
      }

      const inflated = await inflate(data);
      if (!inflated) return null;

      const parm = await this.resolve(parmsList[i] ?? null);
      data =
        parm instanceof Map ? await this.unpredict(inflated, parm) : inflated;
    }

    return data;
  }

  /**
   * Undoes the PNG row filters a Flate stream may have been predicted with.
   * Cross-reference streams almost always use predictor 12, so this is not an
   * exotic path.
   */
  private async unpredict(
    data: Uint8Array<ArrayBuffer>,
    parms: PdfDict,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const predictor = await this.resolve(parms.get("Predictor"));
    if (typeof predictor !== "number" || predictor < 10) return data;

    const columns = (await this.resolve(parms.get("Columns"))) ?? 1;
    const colors = (await this.resolve(parms.get("Colors"))) ?? 1;
    const bits = (await this.resolve(parms.get("BitsPerComponent"))) ?? 8;
    if (
      typeof columns !== "number" ||
      typeof colors !== "number" ||
      typeof bits !== "number"
    ) {
      return data;
    }

    const pixel = Math.ceil((colors * bits) / 8);
    const rowLength = Math.ceil((columns * colors * bits) / 8);
    const rows = Math.floor(data.length / (rowLength + 1));
    const out = new Uint8Array(rows * rowLength);

    let previous = new Uint8Array(rowLength);
    for (let r = 0; r < rows; r++) {
      const type = data[r * (rowLength + 1)];
      const row = data.subarray(
        r * (rowLength + 1) + 1,
        (r + 1) * (rowLength + 1),
      );
      const current = new Uint8Array(row);

      for (let i = 0; i < rowLength; i++) {
        const left = i >= pixel ? current[i - pixel] : 0;
        const up = previous[i];
        const upLeft = i >= pixel ? previous[i - pixel] : 0;

        switch (type) {
          case 1:
            current[i] = (current[i] + left) & 0xff;
            break;
          case 2:
            current[i] = (current[i] + up) & 0xff;
            break;
          case 3:
            current[i] = (current[i] + ((left + up) >> 1)) & 0xff;
            break;
          case 4: {
            const p = left + up - upLeft;
            const dLeft = Math.abs(p - left);
            const dUp = Math.abs(p - up);
            const dUpLeft = Math.abs(p - upLeft);
            const nearest =
              dLeft <= dUp && dLeft <= dUpLeft
                ? left
                : dUp <= dUpLeft
                  ? up
                  : upLeft;
            current[i] = (current[i] + nearest) & 0xff;
            break;
          }
          default:
            break;
        }
      }

      out.set(current, r * rowLength);
      previous = current;
    }

    return out as Uint8Array<ArrayBuffer>;
  }

  /**
   * Rebuilds the object table by scanning the whole source for `N G obj`.
   *
   * The expensive path, and the reason it exists is that a wrong offset is the
   * most common way a PDF is malformed. Over ranged reads it transfers the
   * whole file, which is why it happens only after a lookup has already failed.
   */
  private async recover(): Promise<void> {
    this.recovered = true;

    const total = await this.source.size();
    const all = await this.source.read(0, total);
    if (!all) return;

    const header = /(\d+)\s+(\d+)\s+obj\b/g;
    // Latin-1 maps every byte to exactly one character, so a match index in the
    // decoded text is also a byte offset in the source.
    const text = new TextDecoder("latin1").decode(all);
    const found = [...text.matchAll(header)];

    for (const match of found) {
      const num = Number.parseInt(match[1], 10);
      if (!Number.isInteger(num)) continue;
      // Later definitions win: an incrementally updated file appends its
      // replacements, so the last one in the file is the current one.
      this.objects.set(num, { at: "offset", offset: match.index });
    }

    // Objects inside object streams are not in the text at all, so a scan alone
    // leaves most of a PDF 1.5 file unreachable — including, usually, the very
    // dictionaries this reader is after. Each stream that announces itself as
    // one is opened, and what it holds is registered as living there.
    for (const [i, match] of found.entries()) {
      const num = Number.parseInt(match[1], 10);
      const start = match.index;
      const end = i + 1 < found.length ? found[i + 1].index : text.length;
      // The `/Type` is in the dictionary, which is at the front of the object.
      if (!text.slice(start, Math.min(end, start + 512)).includes("/ObjStm")) {
        continue;
      }

      const contents = await this.objectStream(num);
      for (const member of contents?.keys() ?? []) {
        // An object found loose in the file is preferred: this is the branch
        // where offsets have already proved untrustworthy, but a definition
        // that was read is still better than one that has to be inflated out
        // of a stream whose own offset was equally suspect.
        if (this.objects.has(member)) continue;
        // `index` is what an intact cross-reference stream records; nothing
        // reads it, because members are looked up by number once the stream is
        // parsed.
        this.objects.set(member, { at: "stream", stream: num, index: 0 });
      }
    }

    // A file whose table was unreadable has no trailer either, so recover the
    // parts of it that matter by looking at what the objects say they are.
    if (!this.trailer.has("Root")) {
      const trailerAt = text.lastIndexOf("trailer");
      if (trailerAt !== -1) {
        const parsed = await withWindow(
          this.source,
          trailerAt + "trailer".length,
          (lexer, base) => parseValue(lexer, base),
        );
        if (parsed instanceof Map) {
          for (const [key, value] of parsed) {
            if (!this.trailer.has(key)) this.trailer.set(key, value);
          }
        }
      }
    }

    // Still nothing: find the catalog by its own /Type, and any /Info-carrying
    // cross-reference stream dictionary along with it.
    if (!this.trailer.has("Root")) {
      // A snapshot, because resolving an object stream above may still be
      // adding to the map.
      for (const num of [...this.objects.keys()]) {
        const value = await this.object(num);
        const dict = value instanceof Map ? value : null;
        const stream =
          value &&
          typeof value === "object" &&
          "kind" in value &&
          value.kind === "stream"
            ? value.dict
            : null;
        const candidate = dict ?? stream;
        const type = candidate?.get("Type");
        const name =
          type &&
          typeof type === "object" &&
          "kind" in type &&
          type.kind === "name"
            ? type.value
            : null;

        if (name === "Catalog" && !this.trailer.has("Root")) {
          this.trailer.set("Root", { kind: "ref", num, gen: 0 });
        }
        if (name === "XRef") {
          for (const key of ["Root", "Info"] as const) {
            const found = candidate?.get(key);
            if (found && !this.trailer.has(key)) this.trailer.set(key, found);
          }
        }
      }
    }
  }
}

/**
 * Inflate, through `DecompressionStream` for the same reason the ZIP reader
 * uses it: one implementation that runs in both workerd and Node.
 *
 * Streams with a corrupt or absent zlib header are common enough that raw
 * deflate is tried as well before giving up.
 */
async function inflate(
  data: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const stream = new Response(data).body?.pipeThrough(
        new DecompressionStream(format),
      );
      if (!stream) continue;
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // Try the next format, then report failure.
    }
  }
  return null;
}

/**
 * PDFDocEncoding above 0x7f, which is Latin-1 apart from these. Getting it
 * wrong turns a typographic quote in a title into a stray accented letter.
 */
const PDF_DOC_HIGH = [
  0x2022, 0x2020, 0x2021, 0x2026, 0x2014, 0x2013, 0x0192, 0x2044, 0x2039,
  0x203a, 0x2212, 0x2030, 0x201e, 0x201c, 0x201d, 0x2018, 0x2019, 0x201a,
  0x2122, 0xfb01, 0xfb02, 0x0141, 0x0152, 0x0160, 0x0178, 0x017d, 0x0131,
  0x0142, 0x0153, 0x0161, 0x017e, 0x0000, 0x20ac,
];

/** Whether bytes are valid UTF-8 *and* actually use more than ASCII. */
function looksLikeUtf8(bytes: Uint8Array): boolean {
  let multibyte = false;

  for (let i = 0; i < bytes.length; ) {
    const byte = bytes[i];
    if (byte < 0x80) {
      i++;
      continue;
    }

    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc2 ? 2 : 0;
    if (length === 0 || i + length > bytes.length) return false;
    for (let j = 1; j < length; j++) {
      if ((bytes[i + j] & 0xc0) !== 0x80) return false;
    }

    multibyte = true;
    i += length;
  }

  return multibyte;
}

/**
 * Decodes a PDF text string.
 *
 * A byte-order mark settles it where there is one. Where there is not, the
 * string is PDFDocEncoded by the specification and UTF-8 in practice — enough
 * generators write UTF-8 without a mark that treating well-formed UTF-8 as
 * UTF-8 is the difference between "Erklärung" and "ErklÃ¤rung".
 */
export function decodePdfText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // Not in the specification, but written by some generators anyway.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder().decode(bytes.subarray(3));
  }

  if (looksLikeUtf8(bytes)) return new TextDecoder().decode(bytes);

  let out = "";
  for (const byte of bytes) {
    if (byte >= 0x80 && byte <= 0xa0) {
      const mapped = PDF_DOC_HIGH[byte - 0x80];
      out += mapped ? String.fromCharCode(mapped) : "";
    } else {
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

/**
 * Turns a PDF date — `D:YYYYMMDDHHmmSS+HH'mm'` — into ISO 8601.
 *
 * Everything after the year is optional and routinely absent, so a date may
 * come back as just `2011`. That is the same shape an EPUB's `dc:date` arrives
 * in, which is what the rest of the pipeline already expects.
 */
export function pdfDate(value: string): string | null {
  const match = value
    .trim()
    .match(
      /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/,
    );
  if (!match) return null;

  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    zulu,
    sign,
    tzHour,
    tzMinute,
  ] = match;

  const yearNumber = Number.parseInt(year, 10);
  if (yearNumber < 1000 || yearNumber > 3000) return null;
  if (!month) return year;
  if (!day) return `${year}-${month}`;

  let iso = `${year}-${month}-${day}`;
  if (hour) {
    iso += `T${hour}:${minute ?? "00"}:${second ?? "00"}`;
    if (zulu) iso += "Z";
    else if (sign) iso += `${sign}${tzHour}:${tzMinute ?? "00"}`;
  }

  return iso;
}

/** The catalog's `/Metadata` stream, as text. Null when there is none. */
async function readXmp(reader: PdfReader): Promise<string | null> {
  const root = await reader.resolve(reader.trailerDict.get("Root"));
  if (!(root instanceof Map)) return null;

  const metadata = await reader.resolve(root.get("Metadata"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("kind" in metadata) ||
    metadata.kind !== "stream"
  ) {
    return null;
  }

  const bytes = await reader.streamBytes(metadata);
  if (!bytes || bytes.length === 0) return null;

  // XMP is UTF-8 by specification, and may carry a mark.
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

async function readPageCount(reader: PdfReader): Promise<number | null> {
  const root = await reader.resolve(reader.trailerDict.get("Root"));
  if (!(root instanceof Map)) return null;

  const pages = await reader.resolve(root.get("Pages"));
  if (!(pages instanceof Map)) return null;

  const count = await reader.resolve(pages.get("Count"));
  return typeof count === "number" && count > 0 ? Math.floor(count) : null;
}

async function readInfo(reader: PdfReader): Promise<Record<string, string>> {
  const info = await reader.resolve(reader.trailerDict.get("Info"));
  if (!(info instanceof Map)) return {};

  const out: Record<string, string> = {};
  for (const [key, raw] of info) {
    const value = await reader.resolve(raw);
    if (!value) continue;

    if (typeof value === "object" && "kind" in value) {
      if (value.kind === "string") out[key] = decodePdfText(value.bytes);
      else if (value.kind === "name") out[key] = value.value;
      continue;
    }
    if (typeof value === "number") out[key] = String(value);
  }
  return out;
}

/**
 * Everything this reader knows how to learn about a document, in one pass.
 * Null when the source is not a PDF; a PDF that records nothing comes back
 * with empty fields rather than as a failure.
 */
export async function readPdfMetadata(
  source: ByteSource,
): Promise<PdfMetadata | null> {
  const reader = await PdfReader.open(source);
  if (!reader) return null;

  const encrypted = reader.trailerDict.has("Encrypt");

  // Strings and streams in an encrypted document are ciphertext, and this
  // reader has no decryption. Reporting nothing is better than reporting
  // rubbish, and `encrypted` lets the caller say which happened.
  if (encrypted) {
    return {
      info: {},
      xmp: null,
      pages: await readPageCount(reader),
      encrypted,
    };
  }

  const [info, xmp, pages] = await Promise.all([
    readInfo(reader),
    readXmp(reader),
    readPageCount(reader),
  ]);

  return { info, xmp, pages, encrypted };
}
