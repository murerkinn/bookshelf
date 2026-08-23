import { deflateSync } from "node:zlib";

/**
 * Builds PDFs, for fixtures.
 *
 * Generated rather than downloaded, for the reasons `epub.mjs` gives — and for
 * one more that is specific to this format. A PDF says the same thing several
 * ways: metadata sits in an information dictionary or in an XMP packet, objects
 * sit loose in the file or compressed inside an object stream, and the
 * cross-reference table is either twenty-byte text rows or a predicted binary
 * stream. Which combination a file uses is invisible from the outside and is
 * exactly what a reader gets wrong, so the fixtures are built to order: one per
 * combination, each the smallest file that still exercises it.
 */

const encoder = new TextEncoder();

/** A string, some bytes, or a nested mixture of both. */
export type BytesLike = string | Uint8Array | BytesLike[];

/** A string, some bytes, or a nested mixture of both. */
function bytes(value: BytesLike): Uint8Array {
  if (typeof value === "string") return encoder.encode(value);
  if (Array.isArray(value)) return concat(value);
  return value;
}

function concat(parts: readonly BytesLike[]): Uint8Array {
  const all = parts.map(bytes);
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A literal string, with the characters that would end it escaped. */
export function literal(text: string): string {
  return `(${text.replace(/[\\()]/g, "\\$&")})`;
}

/** A text string as UTF-16BE behind a byte-order mark, written as hex. */
export function utf16(text: string): string {
  let hex = "FEFF";
  for (const character of text) {
    // Always defined: the iterator yields whole code points. Everything the
    // fixtures need is in the basic plane, so four hex digits is enough.
    const code = character.codePointAt(0) ?? 0;
    hex += code.toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

/** A literal string whose bytes are PDFDocEncoded rather than UTF-8. */
export function pdfDocEncoded(codes: readonly number[]): Uint8Array {
  return concat(["(", new Uint8Array(codes), ")"]);
}

/**
 * A minimal XMP packet. Properties are given as they should appear, so a test
 * can write the `rdf:Alt`, `rdf:Seq` and attribute forms that real files mix.
 */
export function xmpPacket(body: string, attributes = ""): string {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
   xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:xmp="http://ns.adobe.com/xap/1.0/"
   xmlns:pdf="http://ns.adobe.com/pdf/1.3/"${attributes ? `\n   ${attributes}` : ""}>
${body}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/** Applies the PNG "Up" row filter, which is what predictor 12 means. */
function predictUp(data: Uint8Array, columns: number): Uint8Array {
  const rows = data.length / columns;
  const out = new Uint8Array(rows * (columns + 1));
  // Annotated, because the rows it later holds are subarrays of `data` and so
  // are backed by whatever buffer that is.
  let previous: Uint8Array = new Uint8Array(columns);

  for (let r = 0; r < rows; r++) {
    const row = data.subarray(r * columns, (r + 1) * columns);
    out[r * (columns + 1)] = 2;
    for (let i = 0; i < columns; i++) {
      out[r * (columns + 1) + 1 + i] = (row[i] - previous[i]) & 0xff;
    }
    previous = row;
  }
  return out;
}

/**
 * Assembles a document from object bodies, filling in the offsets that a
 * cross-reference table is made of.
 *
 * `objects` is indexed by object number, so index zero is unused and left
 * empty. Bodies are written verbatim, which is what lets a test build a stream
 * or a deliberately malformed object.
 */
type XrefStreamSpec = {
  /** The object number the cross-reference stream itself takes. */
  num: number;
  /** Byte widths of the three fields in each row. */
  width: [number, number, number];
  /** Objects that live inside an object stream rather than at an offset. */
  inStream?: Record<number, { stream: number; index: number }>;
};

type Document = {
  /** Indexed by object number, so index zero is unused. */
  objects: (BytesLike | undefined)[];
  /** Entries to put in the trailer, as written. */
  trailer: string;
  header?: string;
  /** Present for a cross-reference stream, absent for a classic table. */
  xrefStream?: XrefStreamSpec | null;
};

function assemble({
  objects,
  trailer,
  header = "%PDF-1.7",
  xrefStream = null,
}: Document): Uint8Array {
  const parts: BytesLike[] = [`${header}\n`];
  // Some readers key on a binary comment after the header; a real file has one.
  parts.push(concat([new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3]), "\n"]));

  let at = parts.reduce((n, part) => n + bytes(part).length, 0);
  const offsets: number[] = [];

  for (const [num, body] of objects.entries()) {
    if (body === undefined) continue;
    offsets[num] = at;
    const object = concat([`${num} 0 obj\n`, body, "\nendobj\n"]);
    parts.push(object);
    at += object.length;
  }

  const startxref = at;

  if (xrefStream) {
    const { num, width } = xrefStream;
    const size = objects.length;
    const rows = new Uint8Array(size * width.reduce((a, b) => a + b, 0));
    const columns = width.reduce((a, b) => a + b, 0);

    // The stream describes itself as well, so its own offset is where the
    // table is about to be written.
    offsets[num] = startxref;

    for (let object = 0; object < size; object++) {
      const row = object * columns;
      const compressed = xrefStream.inStream?.[object];
      const [type, second, third] =
        object === 0
          ? ([0, 0, 0xff] as const)
          : compressed
            ? ([2, compressed.stream, compressed.index] as const)
            : offsets[object]
              ? ([1, offsets[object], 0] as const)
              : ([0, 0, 0xff] as const);

      let cursor = row;
      const fields: [number, number, number] = [type, second, third];
      for (const [i, value] of fields.entries()) {
        const bytesWide = width[i];
        for (let b = bytesWide - 1; b >= 0; b--) {
          rows[cursor + b] = (value >> (8 * (bytesWide - 1 - b))) & 0xff;
        }
        cursor += bytesWide;
      }
    }

    const predicted = predictUp(rows, columns);
    const data = deflateSync(predicted);
    const dict =
      `<< /Type /XRef /Size ${size} /W [${width.join(" ")}] ` +
      `/Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 12 /Columns ${columns} >> ` +
      `/Length ${data.length} ${trailer} >>`;

    parts.push(
      concat([
        `${num} 0 obj\n`,
        dict,
        "\nstream\n",
        data,
        "\nendstream\nendobj\n",
      ]),
    );
  } else {
    const rows = [`xref\n0 ${objects.length}\n`, "0000000000 65535 f \n"];
    for (let object = 1; object < objects.length; object++) {
      rows.push(
        offsets[object]
          ? `${String(offsets[object]).padStart(10, "0")} 00000 n \n`
          : "0000000000 65535 f \n",
      );
    }
    parts.push(rows.join(""));
    parts.push(`trailer\n<< /Size ${objects.length} ${trailer} >>\n`);
  }

  parts.push(`startxref\n${startxref}\n%%EOF\n`);
  return concat(parts);
}

/** A Flate-compressed stream object, dictionary entries and all. */
function flateStream(extra: string, payload: BytesLike): Uint8Array {
  const data = deflateSync(bytes(payload));
  return concat([
    `<< ${extra} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
    data,
    "\nendstream",
  ]);
}

/**
 * The oldest shape a PDF comes in: a text cross-reference table, and metadata
 * in the information dictionary. Most PDFs in the wild are still this.
 */
/** What a fixture records about itself. */
export type PdfSpec = {
  /** Information-dictionary entries, as written, e.g. `/Title (X)`. */
  info?: BytesLike;
  /** An XMP packet, from {@link xmpPacket}. */
  xmp?: string | null;
  pages?: number;
};

export function classicPdf({
  info = "",
  xmp = null,
  pages = 1,
}: PdfSpec = {}): Uint8Array {
  const objects: (BytesLike | undefined)[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${xmp ? " /Metadata 5 0 R" : ""} >>`;
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count ${pages} >>`;
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>";
  objects[4] = concat(["<< ", info, " >>"]);
  if (xmp) {
    objects[5] = flateStream("/Type /Metadata /Subtype /XML", xmp);
  }

  return assemble({
    objects,
    header: "%PDF-1.4",
    trailer: "/Root 1 0 R /Info 4 0 R",
  });
}

/**
 * The shape PDF 1.5 introduced and every modern writer uses: the information
 * dictionary hidden inside a compressed object stream, and a cross-reference
 * stream — predicted, so that reading it exercises the un-predictor too.
 *
 * This is the combination that a reader working from raw bytes cannot see into
 * at all, and the information dictionary is put last inside the object stream
 * on purpose: it ends at the final byte of the decompressed data, which is
 * where a parser that treats "out of bytes" as a failure loses it.
 */
export function objectStreamPdf({
  info = "",
  xmp = null,
  pages = 1,
}: PdfSpec = {}): Uint8Array {
  const objects: (BytesLike | undefined)[] = [];
  objects[2] = `<< /Type /Pages /Kids [3 0 R] /Count ${pages} >>`;
  objects[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>";
  if (xmp) {
    objects[5] = flateStream("/Type /Metadata /Subtype /XML", xmp);
  }

  // Objects 1 (the catalog) and 4 (the information dictionary) live in here.
  const catalog = `<< /Type /Catalog /Pages 2 0 R${xmp ? " /Metadata 5 0 R" : ""} >>`;
  const information = concat(["<< ", info, " >>"]);
  const header = `1 0 4 ${catalog.length + 1} `;
  const payload = concat([header, catalog, " ", information]);
  objects[6] = flateStream(
    `/Type /ObjStm /N 2 /First ${header.length}`,
    payload,
  );

  objects[7] = undefined;

  return assemble({
    objects: [...objects, undefined],
    header: "%PDF-1.5",
    trailer: "/Root 1 0 R /Info 4 0 R",
    xrefStream: {
      num: 7,
      width: [1, 4, 2],
      inStream: {
        1: { stream: 6, index: 0 },
        4: { stream: 6, index: 1 },
      },
    },
  });
}

/** A document whose `startxref` points nowhere, so only a scan can read it. */
export function brokenXrefPdf(options?: PdfSpec): Uint8Array {
  const intact = classicPdf(options);
  const text = new TextDecoder("latin1").decode(intact);
  const at = text.lastIndexOf("startxref");
  return concat([
    intact.subarray(0, at),
    `startxref\n${intact.length + 4096}\n%%EOF\n`,
  ]);
}

/** The same document with junk in front, which shifts every recorded offset. */
export function shiftedPdf(options?: PdfSpec): Uint8Array {
  return concat(["junk that is not a PDF\n".repeat(4), classicPdf(options)]);
}
