import { deflateSync } from "node:zlib";
import { filler, PLACEHOLDER } from "./prose.js";

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

/**
 * The characters a Type 1 font's WinAnsi encoding puts outside Latin-1.
 *
 * Everything from U+00A0 to U+00FF is at its own code point in WinAnsi; these
 * eight are the ones Windows put in the C1 control range, and they are exactly
 * the punctuation prose is written with. Without this a page's em dash arrives
 * as its three UTF-8 bytes and is drawn as `â€"`.
 */
const WIN_ANSI: Record<string, number> = {
  "\u2014": 0x97,
  "\u2013": 0x96,
  "\u2018": 0x91,
  "\u2019": 0x92,
  "\u201c": 0x93,
  "\u201d": 0x94,
  "\u2022": 0x95,
  "\u2026": 0x85,
};

/**
 * A literal string for a page's content stream, encoded the way the font on it
 * expects to be spoken to.
 *
 * A content stream is bytes, and a `/WinAnsiEncoding` font reads each one as a
 * character in that encoding — not as UTF-8. Anything above the ASCII range is
 * therefore written as an octal escape, which keeps the stream itself ASCII and
 * says exactly which byte was meant. A character with no WinAnsi equivalent
 * becomes a question mark, because a fixture that silently dropped it would be
 * a fixture whose text does not match its own source.
 */
export function winAnsi(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0x3f;

    if (character === "(" || character === ")" || character === "\\") {
      out += `\\${character}`;
    } else if (code >= 0x20 && code < 0x7f) {
      out += character;
    } else if (WIN_ANSI[character] !== undefined) {
      out += `\\${WIN_ANSI[character].toString(8).padStart(3, "0")}`;
    } else if (code >= 0xa0 && code <= 0xff) {
      out += `\\${code.toString(8).padStart(3, "0")}`;
    } else {
      out += "?";
    }
  }
  return `(${out})`;
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

/**
 * A PDF that is actually a book: text on numbered pages, in real fonts, with
 * chapter bookmarks that lead to them.
 *
 * Everything above this point in the file builds the smallest file that
 * exercises one structural quirk — those are for the metadata readers, and they
 * have no page content at all because none was needed. A reader is the other
 * kind of test: it needs something to render, something to select, something to
 * search and something to jump to. So this one is a whole document.
 *
 * Only the fourteen fonts every PDF reader is required to have are used, so
 * nothing is embedded and the file stays small enough to keep in a repository's
 * memory rather than on its disk.
 */

/** Letter, in PDF units, which are 1/72 inch. */
const PAGE = { width: 612, height: 792 };
const MARGIN = 72;

const BODY_SIZE = 11;
const LEADING = 15.5;
const HEADING_SIZE = 22;

/**
 * Helvetica's average advance, near enough to wrap by.
 *
 * Wrapping properly means the font's width metrics for every glyph, which is a
 * table this does not carry — and the consequence of being slightly out is a
 * line that ends a word early. A fixture can afford that; a typesetter could
 * not.
 */
const AVERAGE_ADVANCE = 0.5;

function wrap(text: string, size: number, width: number): string[] {
  const columns = Math.floor(width / (size * AVERAGE_ADVANCE));
  const lines: string[] = [];
  let line = "";

  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= columns) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** XMP is XML, and a title with an ampersand in it would end the document. */
function escapeXmp(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** One page's drawing instructions. */
type Drawn = { heading?: string; lines: string[]; folio: number };

function contentStream({ heading, lines, folio }: Drawn): string {
  const parts: string[] = [];
  let y = PAGE.height - MARGIN;

  if (heading) {
    parts.push(
      "BT",
      `/F2 ${HEADING_SIZE} Tf`,
      `${MARGIN} ${y - HEADING_SIZE} Td`,
      `${winAnsi(heading)} Tj`,
      "ET",
    );
    y -= HEADING_SIZE * 2.2;
  }

  if (lines.length > 0) {
    parts.push(
      "BT",
      `/F1 ${BODY_SIZE} Tf`,
      `${LEADING} TL`,
      `${MARGIN} ${y - BODY_SIZE} Td`,
    );
    for (const [index, line] of lines.entries()) {
      // The first line is already where `Td` put it; every one after it moves
      // down by the leading first.
      if (index > 0) parts.push("T*");
      parts.push(`${winAnsi(line)} Tj`);
    }
    parts.push("ET");
  }

  // The folio, centred-ish. Exact centring would need the width metrics that
  // the wrapping does without.
  parts.push(
    "BT",
    "/F1 9 Tf",
    `${PAGE.width / 2 - 8} ${MARGIN / 2} Td`,
    `${winAnsi(String(folio))} Tj`,
    "ET",
  );

  return parts.join("\n");
}

export type BookPdfSpec = {
  title: string;
  authors?: string[];
  publisher?: string;
  published?: string;
  subjects?: string[];
  description?: string;
  chapters?: number;
  /** Paragraphs per chapter, which is what decides how many pages there are. */
  paragraphs?: number;
};

export function bookPdf({
  title,
  authors = [],
  publisher,
  published,
  subjects = [],
  description,
  chapters = 4,
  paragraphs = 9,
}: BookPdfSpec): Uint8Array {
  const column = PAGE.width - MARGIN * 2;
  const perPage = Math.floor((PAGE.height - MARGIN * 2 - LEADING) / LEADING);

  /** Every page, and which chapter each one opened. */
  const drawn: Drawn[] = [];
  const opens: number[] = [];

  // A title page, so the first thing a reader sees is not a wall of filler.
  drawn.push({
    heading: title,
    lines: [
      ...(authors.length > 0 ? [authors.join(", "), ""] : []),
      ...(publisher ? [publisher] : []),
      ...(published ? [published] : []),
      "",
      ...wrap(PLACEHOLDER.replace(/\s+/g, " "), BODY_SIZE, column),
    ],
    folio: 1,
  });

  for (let chapter = 1; chapter <= chapters; chapter++) {
    const heading = `Chapter ${chapter}`;
    const lines: string[] = [];
    for (const paragraph of filler(chapter, paragraphs)) {
      lines.push(...wrap(paragraph, BODY_SIZE, column), "");
    }

    opens.push(drawn.length + 1);

    // The heading takes the room of a few lines, so the chapter's first page
    // holds fewer of them than the ones that follow it.
    const firstPage = perPage - 4;
    drawn.push({
      heading,
      lines: lines.slice(0, firstPage),
      folio: drawn.length + 1,
    });

    for (let at = firstPage; at < lines.length; at += perPage) {
      drawn.push({
        lines: lines.slice(at, at + perPage),
        folio: drawn.length + 1,
      });
    }
  }

  // Object numbers are laid out before anything is written, because a page has
  // to name its content stream and a bookmark has to name its page.
  const catalogNum = 1;
  const pagesNum = 2;
  const infoNum = 3;
  const bodyFontNum = 4;
  const headingFontNum = 5;
  const outlinesNum = 6;
  const metadataNum = 7;
  const firstPageNum = 8;
  const pageNum = (index: number) => firstPageNum + index * 2;
  const contentNum = (index: number) => firstPageNum + index * 2 + 1;
  const firstItemNum = firstPageNum + drawn.length * 2;

  const objects: (BytesLike | undefined)[] = [];

  objects[catalogNum] =
    `<< /Type /Catalog /Pages ${pagesNum} 0 R /Metadata ${metadataNum} 0 R` +
    (opens.length > 0
      ? ` /Outlines ${outlinesNum} 0 R /PageMode /UseOutlines`
      : "") +
    " >>";

  objects[pagesNum] =
    `<< /Type /Pages /Count ${drawn.length} /Kids [` +
    drawn.map((_, index) => `${pageNum(index)} 0 R`).join(" ") +
    "] >>";

  objects[infoNum] = concat([
    "<< ",
    `/Title ${literal(title)} `,
    authors.length > 0 ? `/Author ${literal(authors.join(", "))} ` : "",
    subjects.length > 0 ? `/Keywords ${literal(subjects.join(", "))} ` : "",
    description ? `/Subject ${literal(description)} ` : "",
    // `/Producer` is the program that wrote the file, not the house that
    // published the book — a distinction real PDFs get wrong often enough that
    // it is worth a fixture getting it right.
    "/Producer (Bookshelf fixtures) ",
    // Spelled out to the minute of offset. `Z` on its own is legal and some
    // readers still get the year wrong from it.
    published ? `/CreationDate (D:${published}0101000000Z00'00') ` : "",
    ">>",
  ]);

  // The other half of a modern PDF's metadata. A publisher and a real
  // publication date have nowhere to live in the information dictionary, which
  // is the reason XMP exists and the reason a reader has to read both.
  objects[metadataNum] = flateStream(
    "/Type /Metadata /Subtype /XML",
    xmpPacket(
      [
        `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmp(title)}</rdf:li></rdf:Alt></dc:title>`,
        authors.length > 0
          ? `   <dc:creator><rdf:Seq>${authors
              .map((author) => `<rdf:li>${escapeXmp(author)}</rdf:li>`)
              .join("")}</rdf:Seq></dc:creator>`
          : "",
        publisher
          ? `   <dc:publisher><rdf:Bag><rdf:li>${escapeXmp(publisher)}</rdf:li></rdf:Bag></dc:publisher>`
          : "",
        description
          ? `   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmp(description)}</rdf:li></rdf:Alt></dc:description>`
          : "",
        subjects.length > 0
          ? `   <dc:subject><rdf:Bag>${subjects
              .map((subject) => `<rdf:li>${escapeXmp(subject)}</rdf:li>`)
              .join("")}</rdf:Bag></dc:subject>`
          : "",
        published ? `   <dc:date>${escapeXmp(published)}</dc:date>` : "",
        "   <dc:language><rdf:Bag><rdf:li>en</rdf:li></rdf:Bag></dc:language>",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  );

  objects[bodyFontNum] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[headingFontNum] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

  for (const [index, page] of drawn.entries()) {
    const body = contentStream(page);
    objects[pageNum(index)] =
      `<< /Type /Page /Parent ${pagesNum} 0 R ` +
      `/MediaBox [0 0 ${PAGE.width} ${PAGE.height}] ` +
      `/Resources << /Font << /F1 ${bodyFontNum} 0 R /F2 ${headingFontNum} 0 R >> >> ` +
      `/Contents ${contentNum(index)} 0 R >>`;
    objects[contentNum(index)] = flateStream("", body);
  }

  if (opens.length > 0) {
    objects[outlinesNum] =
      `<< /Type /Outlines /Count ${opens.length} ` +
      `/First ${firstItemNum} 0 R /Last ${firstItemNum + opens.length - 1} 0 R >>`;

    for (const [index, page] of opens.entries()) {
      const self = firstItemNum + index;
      objects[self] = concat([
        `<< /Title ${literal(`Chapter ${index + 1}`)} `,
        `/Parent ${outlinesNum} 0 R `,
        index > 0 ? `/Prev ${self - 1} 0 R ` : "",
        index < opens.length - 1 ? `/Next ${self + 1} 0 R ` : "",
        // An explicit destination, which is the form a reader can resolve
        // without a name tree: the page itself, then how to sit on it.
        `/Dest [${pageNum(page - 1)} 0 R /XYZ null null null] >>`,
      ]);
    }
  }

  return assemble({
    objects,
    header: "%PDF-1.7",
    trailer: `/Root ${catalogNum} 0 R /Info ${infoNum} 0 R`,
  });
}
