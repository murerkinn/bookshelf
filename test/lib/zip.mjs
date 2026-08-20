import { createHash } from "node:crypto";

/**
 * A minimal ZIP writer, for building test fixtures.
 *
 * Every entry is stored rather than deflated. That is a valid archive — the
 * reader in @bookshelf/core handles method 0 and method 8 alike — and it keeps
 * this to a CRC and some little-endian headers with no compression to get
 * wrong. It also satisfies for free the one structural rule EPUB adds: that
 * `mimetype` comes first and uncompressed.
 *
 * Timestamps are fixed so the same input always produces the same bytes. A
 * fixture that changes every time it is generated cannot be compared.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 1 January 2020, in the DOS format ZIP records. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function bytesOf(content) {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}

/**
 * @param {Array<{name: string, content: string | Uint8Array}>} entries
 * @returns {Uint8Array} the archive
 */
export function writeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = bytesOf(entry.content);
    const crc = crc32(data);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, 0, true); // flags
    header.setUint16(8, 0, true); // method: stored
    header.setUint16(10, DOS_TIME, true);
    header.setUint16(12, DOS_DATE, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true); // compressed size
    header.setUint32(22, data.length, true); // uncompressed size
    header.setUint16(26, name.length, true);
    header.setUint16(28, 0, true); // extra field length
    local.push(new Uint8Array(header.buffer), name, data);

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true); // central directory entry
    record.setUint16(4, 20, true); // version made by
    record.setUint16(6, 20, true); // version needed
    record.setUint16(8, 0, true); // flags
    record.setUint16(10, 0, true); // method: stored
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, data.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, 0, true); // extra
    record.setUint16(32, 0, true); // comment
    record.setUint16(34, 0, true); // disk
    record.setUint16(36, 0, true); // internal attributes
    record.setUint32(38, 0, true); // external attributes
    record.setUint32(42, offset, true); // offset of the local header
    central.push(new Uint8Array(record.buffer), name);

    offset += 30 + name.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(4, 0, true); // this disk
  end.setUint16(6, 0, true); // disk holding the directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true); // directory offset
  end.setUint16(20, 0, true); // comment length

  const parts = [...local, ...central, new Uint8Array(end.buffer)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const archive = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    archive.set(part, cursor);
    cursor += part.length;
  }
  return archive;
}

/** A stable digest, for asserting that generation is deterministic. */
export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
