import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

/**
 * A minimal ZIP writer, for building test fixtures.
 *
 * Entries are stored by default rather than deflated. That is a valid archive —
 * the reader in @bookshelf/core handles method 0 and method 8 alike — and it
 * keeps the common case to a CRC and some little-endian headers with no
 * compression to get wrong. It also satisfies for free the one structural rule
 * EPUB adds: that `mimetype` comes first and uncompressed.
 *
 * Everything else here exists because the reader claims to cope with it, and a
 * claim about a format is only worth as much as an archive that exercises it:
 * deflated entries, a local header padded with an extra field it has to parse
 * past, sizes moved into a trailing data descriptor, a trailing archive comment
 * that pushes the end record back out of place, and a Zip64 marker it should
 * refuse rather than misread.
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

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 1 January 2020, in the DOS format ZIP records. */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string"
    ? new TextEncoder().encode(content)
    : new Uint8Array(content);
}

/** Flags bit 3: the sizes live in a descriptor after the data. */
const DATA_DESCRIPTOR_FLAG = 0x08;

/** One entry to write, and how to write it. */
export type ZipEntryInput = {
  name: string;
  content: string | Uint8Array;
  /** Deflate rather than store, exercising method 8. */
  deflate?: boolean;
  /** Put the sizes in a trailing descriptor, as a streamed archive does. */
  dataDescriptor?: boolean;
  /** Pad the local header with this many bytes of extra field. */
  extra?: number;
};

export type ZipOptions = {
  /** A trailing comment, which pushes the end record out of place. */
  comment?: string;
  /** Saturate the end record's fields, marking the archive as Zip64. */
  zip64?: boolean;
};

export function writeZip(
  entries: readonly ZipEntryInput[],
  options: ZipOptions = {},
): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const data = bytesOf(entry.content);
    const crc = crc32(data);
    const body = entry.deflate ? deflateRawSync(data) : data;
    const method = entry.deflate ? 8 : 0;
    const flags = entry.dataDescriptor ? DATA_DESCRIPTOR_FLAG : 0;
    // Padding the local header, which the central directory does not describe.
    const extra = new Uint8Array(entry.extra ?? 0);

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true); // local file header
    header.setUint16(4, 20, true); // version needed
    header.setUint16(6, flags, true);
    header.setUint16(8, method, true);
    header.setUint16(10, DOS_TIME, true);
    header.setUint16(12, DOS_DATE, true);
    // A streamed entry does not know these yet, and writes zeroes. The central
    // directory records them, which is the only place they can be read from.
    header.setUint32(14, entry.dataDescriptor ? 0 : crc, true);
    header.setUint32(18, entry.dataDescriptor ? 0 : body.length, true);
    header.setUint32(22, entry.dataDescriptor ? 0 : data.length, true);
    header.setUint16(26, name.length, true);
    header.setUint16(28, extra.length, true);
    local.push(new Uint8Array(header.buffer), name, extra, body);

    let descriptor = new Uint8Array(0);
    if (entry.dataDescriptor) {
      const trailer = new DataView(new ArrayBuffer(16));
      trailer.setUint32(0, 0x08074b50, true); // data descriptor signature
      trailer.setUint32(4, crc, true);
      trailer.setUint32(8, body.length, true);
      trailer.setUint32(12, data.length, true);
      descriptor = new Uint8Array(trailer.buffer);
      local.push(descriptor);
    }

    const record = new DataView(new ArrayBuffer(46));
    record.setUint32(0, 0x02014b50, true); // central directory entry
    record.setUint16(4, 20, true); // version made by
    record.setUint16(6, 20, true); // version needed
    record.setUint16(8, flags, true);
    record.setUint16(10, method, true);
    record.setUint16(12, DOS_TIME, true);
    record.setUint16(14, DOS_DATE, true);
    record.setUint32(16, crc, true);
    record.setUint32(20, body.length, true);
    record.setUint32(24, data.length, true);
    record.setUint16(28, name.length, true);
    record.setUint16(30, 0, true); // extra
    record.setUint16(32, 0, true); // comment
    record.setUint16(34, 0, true); // disk
    record.setUint16(36, 0, true); // internal attributes
    record.setUint32(38, 0, true); // external attributes
    record.setUint32(42, offset, true); // offset of the local header
    central.push(new Uint8Array(record.buffer), name);

    offset += 30 + name.length + extra.length + body.length + descriptor.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const comment = new TextEncoder().encode(options.comment ?? "");
  const saturated = 0xffffffff;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central directory
  end.setUint16(4, 0, true); // this disk
  end.setUint16(6, 0, true); // disk holding the directory
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  // Zip64 marks these as saturated and puts the real values in a separate
  // record. An archive claiming that is one this reader must refuse.
  end.setUint32(12, options.zip64 ? saturated : centralSize, true);
  end.setUint32(16, options.zip64 ? saturated : offset, true);
  end.setUint16(20, comment.length, true);

  const parts = [...local, ...central, new Uint8Array(end.buffer), comment];
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
export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
