import { deflateSync } from "node:zlib";
import { filler, PLACEHOLDER } from "./prose.js";
import { crc32, writeZip } from "./zip.js";

/**
 * Builds EPUBs, for fixtures and for the demo shelf.
 *
 * Generated rather than downloaded, which matters for more than convenience:
 * a fixture with no network dependency runs the same in CI, on a plane, and in
 * five years when whatever it was fetched from has reorganised its URLs. It
 * also means the demo shelf can be created anywhere with no rate limit to be
 * polite about.
 *
 * The titles are real public-domain works so a shelf of them looks like a
 * shelf. The prose is not theirs — see PLACEHOLDER.
 */

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  body.set(new TextEncoder().encode(type), 0);
  body.set(data, 4);

  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out.set(body, 4);
  view.setUint32(8 + data.length, crc32(body), false);
  return out;
}

/**
 * A cover that reads as a cover: a vertical gradient with two lighter bands
 * where a title and an author would sit. A flat rectangle is easier to
 * generate and looks, at thumbnail size, exactly like a cover that failed to
 * load — which is the wrong thing for a demo shelf to suggest.
 */
export function coverArt(
  width: number,
  height: number,
  [r, g, b]: Rgb,
): Uint8Array {
  const pixel = (x: number, y: number): Rgb => {
    // Darker towards the bottom, by up to a third.
    const shade = 1 - (y / height) * 0.35;
    let [pr, pg, pb] = [r * shade, g * shade, b * shade];

    const inset = Math.round(width * 0.16);
    const band = (top: number, thickness: number) =>
      y >= Math.round(height * top) &&
      y < Math.round(height * top) + thickness &&
      x >= inset &&
      x < width - inset;

    // A title block and a shorter author line under it. Deliberately chunky:
    // the shelf renders a cover into a 40x60 slot, so anything thinner than
    // about 6% of the height washes out entirely on the way down.
    if (band(0.52, Math.round(height * 0.09))) {
      [pr, pg, pb] = [pr + 120, pg + 120, pb + 118];
    } else if (
      band(0.66, Math.round(height * 0.05)) &&
      x < width - inset - Math.round(width * 0.3)
    ) {
      [pr, pg, pb] = [pr + 80, pg + 80, pb + 78];
    }

    return [
      Math.min(255, Math.round(pr)),
      Math.min(255, Math.round(pg)),
      Math.min(255, Math.round(pb)),
    ];
  };

  return png(width, height, pixel);
}

/** Red, green, blue, each 0-255. */
export type Rgb = [number, number, number];

/**
 * A PNG from a pixel function. Real image bytes rather than a stub, because
 * the sync tool hands covers to cwebp or sips and those will not thumbnail a
 * fake.
 */
export function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => Rgb,
): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  // Each scanline carries a leading filter byte, here always "none".
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const px = row + 1 + x * 3;
      const [r, g, b] = pixel(x, y);
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chapterXhtml(title: string, heading: string, index: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>${escapeXml(heading)}</title></head>
  <body>
    <section epub:type="chapter" xmlns:epub="http://www.idpf.org/2007/ops">
      <h1>${escapeXml(heading)}</h1>
      <p><em>${escapeXml(title)}</em>, chapter ${index}.</p>
      <p>${escapeXml(PLACEHOLDER.replace(/\n/g, " "))}</p>
      ${filler(index)
        .map((paragraph) => `<p>${escapeXml(paragraph)}</p>`)
        .join("\n      ")}
    </section>
  </body>
</html>
`;
}

/** A book to generate. Only a title is required. */
export type BookSpec = {
  title: string;
  authors?: string[];
  publisher?: string;
  published?: string;
  language?: string;
  description?: string;
  subjects?: string[];
  chapters?: number;
  /** The cover's base colour. */
  colour?: Rgb;
  /** False for a book with no cover at all, which the shelf has a tile for. */
  cover?: boolean;
};

export function epub(book: BookSpec): Uint8Array {
  const {
    title,
    authors = [],
    publisher,
    published,
    language = "en",
    description,
    subjects = [],
    chapters = 3,
    colour = [90, 110, 150],
    cover = true,
  } = book;

  const chapterFiles = Array.from({ length: chapters }, (_, i) => ({
    id: `chapter-${i + 1}`,
    href: `chapter-${i + 1}.xhtml`,
    heading: `Chapter ${i + 1}`,
  }));

  const metadata = [
    `<dc:title>${escapeXml(title)}</dc:title>`,
    ...authors.map((a) => `<dc:creator>${escapeXml(a)}</dc:creator>`),
    publisher ? `<dc:publisher>${escapeXml(publisher)}</dc:publisher>` : "",
    published ? `<dc:date>${escapeXml(published)}</dc:date>` : "",
    `<dc:language>${escapeXml(language)}</dc:language>`,
    // Slugified from the raw title, not the escaped one, or an ampersand
    // would arrive here as the word "amp".
    `<dc:identifier id="pub-id">urn:uuid:bookshelf-${title
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()}</dc:identifier>`,
    description
      ? `<dc:description>${escapeXml(description)}</dc:description>`
      : "",
    ...subjects.map((s) => `<dc:subject>${escapeXml(s)}</dc:subject>`),
  ].filter(Boolean);

  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    // `properties="cover-image"` is the EPUB 3 way, and the first thing the
    // sync tool looks for.
    cover
      ? `<item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>`
      : "",
    ...chapterFiles.map(
      (c) =>
        `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`,
    ),
  ].filter(Boolean);

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    ${metadata.join("\n    ")}
  </metadata>
  <manifest>
    ${manifest.join("\n    ")}
  </manifest>
  <spine>
    ${chapterFiles.map((c) => `<itemref idref="${c.id}"/>`).join("\n    ")}
  </spine>
</package>
`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Contents</h1>
      <ol>
        ${chapterFiles.map((c) => `<li><a href="${c.href}">${c.heading}</a></li>`).join("\n        ")}
      </ol>
    </nav>
  </body>
</html>
`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

  return writeZip([
    // First and stored, as the specification requires.
    { name: "mimetype", content: "application/epub+zip" },
    { name: "META-INF/container.xml", content: container },
    { name: "OEBPS/content.opf", content: opf },
    { name: "OEBPS/nav.xhtml", content: nav },
    ...(cover
      ? [{ name: "OEBPS/cover.png", content: coverArt(240, 360, colour) }]
      : []),
    ...chapterFiles.map((c, i) => ({
      name: `OEBPS/${c.href}`,
      content: chapterXhtml(title, c.heading, i + 1),
    })),
  ]);
}
