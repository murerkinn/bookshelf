import type { ByteSource } from "./bytes.js";

/**
 * A minimal read-only ZIP reader, written over {@link ByteSource} so that the
 * same parser serves a book held in memory and a book in object storage. The
 * ranged path is why opening a 40 MB EPUB to read one chapter doesn't cost
 * 40 MB.
 *
 * Only the parts of the format EPUBs actually use are implemented: the central
 * directory, stored (method 0) and deflated (method 8) entries. Zip64 archives
 * are rejected rather than mis-parsed.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

/** 22-byte EOCD record plus the largest possible 64 KB trailing comment. */
const MAX_EOCD_SIZE = 22 + 0xffff;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

export type ZipDirectory = Map<string, ZipEntry>;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Decompression goes through `DecompressionStream` rather than `node:zlib`,
 * which is what lets one implementation run in both workerd and Node and keeps
 * this package free of any runtime-specific import.
 */
async function inflate(
  data: Uint8Array<ArrayBuffer>,
  method: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (method === 0) return data;
  if (method !== 8) {
    throw new Error(`unsupported zip compression method: ${method}`);
  }

  const stream = new Response(data).body?.pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  if (!stream) throw new Error("failed to open decompression stream");

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads the archive's central directory. Returns `null` when the source isn't a
 * ZIP, is Zip64, or is otherwise unreadable — callers treat that as "no cover"
 * or "not a readable book" rather than as an error.
 */
export async function readZipDirectory(
  source: ByteSource,
): Promise<ZipDirectory | null> {
  const totalSize = await source.size();
  if (totalSize < 22) return null;

  const tailSize = Math.min(totalSize, MAX_EOCD_SIZE);
  const tail = await source.read(totalSize - tailSize, tailSize);
  if (!tail || tail.length < 22) return null;

  const tailView = viewOf(tail);

  // The EOCD sits at the very end, but a trailing comment can push it back, so
  // scan backwards for its signature.
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = tailView.getUint16(eocd + 10, true);
  const directorySize = tailView.getUint32(eocd + 12, true);
  const directoryOffset = tailView.getUint32(eocd + 16, true);

  // Zip64 marks these fields as saturated; we don't support the extension.
  if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    return null;
  }

  const directory = await source.read(directoryOffset, directorySize);
  if (!directory) return null;

  const view = viewOf(directory);
  const entries: ZipDirectory = new Map();
  const decoder = new TextDecoder();
  let cursor = 0;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > directory.length) break;
    if (view.getUint32(cursor, true) !== CENTRAL_FILE_SIGNATURE) break;

    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(
      directory.subarray(cursor + 46, cursor + 46 + nameLength),
    );

    entries.set(name, { name, method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Room for the local header's extra field, which the central directory doesn't
 * predict. Timestamp and Unix-attribute fields run to a few dozen bytes; 512 is
 * far past anything in practice, and overshooting only wastes those bytes.
 */
const EXTRA_FIELD_ALLOWANCE = 512;

/** Flags bit 3: sizes live in a trailing data descriptor, not in the header. */
const DATA_DESCRIPTOR_FLAG = 0x08;

/**
 * Reads and decompresses a single entry.
 *
 * The entry's data doesn't begin at a position the central directory records —
 * a local header of unknown length sits in front of it. Reading that header
 * first and the data second would make every entry cost two sequential round
 * trips, so instead one read covers the header, a generous allowance for it,
 * and the data, and the header is parsed back out of the result. Only an
 * implausibly large extra field falls back to a second read.
 *
 * The header is also believed over the directory about how long the data is.
 * A caller may hold a directory that no longer describes the object — the app
 * memoises one per book, and republishing replaces the object underneath it —
 * and a stale length silently truncates the entry, which is far worse than
 * failing. Where the header cannot say (a streamed archive puts its sizes in a
 * trailing descriptor) the directory is all there is, and stands.
 *
 * Returns null when the entry is not where it was said to be, which is the
 * other way a stale directory shows up. Callers that cache one can take that
 * as a reason to read it again.
 */
export async function readZipEntry(
  source: ByteSource,
  entry: ZipEntry,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const nameLength = new TextEncoder().encode(entry.name).length;
  const speculative =
    30 + nameLength + EXTRA_FIELD_ALLOWANCE + entry.compressedSize;

  const block = await source.read(entry.localOffset, speculative);
  if (!block || block.length < 30) return null;

  const view = viewOf(block);
  if (view.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) return null;

  // Compared by length rather than by bytes: a name is stored in whatever
  // encoding the archive was written with, so decoding and re-encoding it is
  // not guaranteed to round-trip, and a mismatch there would reject a
  // perfectly good entry. The length is enough to catch an offset pointing at
  // some other entry's header.
  if (view.getUint16(26, true) !== nameLength) return null;

  const streamed = (view.getUint16(6, true) & DATA_DESCRIPTOR_FLAG) !== 0;
  const declared = view.getUint32(18, true);
  const compressedSize =
    !streamed && declared > 0 ? declared : entry.compressedSize;

  const headerLength = 30 + nameLength + view.getUint16(28, true);
  const end = headerLength + compressedSize;

  if (end <= block.length) {
    return inflate(
      block.subarray(headerLength, end) as Uint8Array<ArrayBuffer>,
      entry.method,
    );
  }

  const data = await source.read(
    entry.localOffset + headerLength,
    compressedSize,
  );
  if (!data) return null;

  return inflate(data, entry.method);
}
