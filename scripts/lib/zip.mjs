import { inflateRawSync } from "node:zlib";

/**
 * A minimal read-only ZIP reader. Only what EPUBs use is implemented: the
 * central directory, stored (method 0) and deflated (method 8) entries.
 * Zip64 archives are rejected rather than mis-parsed.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

/** Maps entry name -> {method, compressedSize, localOffset}, or null if not a ZIP. */
export function readZipDirectory(buffer) {
  // The EOCD is last, but a trailing comment can push it back by up to 64 KB.
  const limit = Math.max(0, buffer.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = buffer.length - 22; i >= limit; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffffffff) return null; // Zip64, unsupported

  const entries = new Map();
  let cursor = directoryOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buffer.length) break;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) break;

    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    entries.set(name, { method, compressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

export function readZipEntry(buffer, entry) {
  const { localOffset } = entry;
  if (buffer.readUInt32LE(localOffset) !== LOCAL_FILE_SIGNATURE) return null;

  // The local header repeats the name and extra fields, and its extra field
  // length can differ from the central directory's.
  const start =
    localOffset +
    30 +
    buffer.readUInt16LE(localOffset + 26) +
    buffer.readUInt16LE(localOffset + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip compression method: ${entry.method}`);
}
