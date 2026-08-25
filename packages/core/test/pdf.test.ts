import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesSource, pdfDate, readPdfMetadata } from "@bookshelf/core";
import {
  bookPdf,
  brokenXrefPdf,
  classicPdf,
  literal,
  objectStreamPdf,
  pdfDocEncoded,
  shiftedPdf,
  utf16,
  winAnsi,
} from "@bookshelf/fixtures";

function read(bytes) {
  return readPdfMetadata(bytesSource(bytes));
}

test("reads an information dictionary out of a classic cross-reference table", async () => {
  const pdf = classicPdf({
    info: `/Title ${literal("Tidewater Tables")} /Author ${literal("Marta Quill")} /CreationDate (D:20200102030405Z)`,
    pages: 12,
  });

  const document = await read(pdf);
  assert.equal(document.info.Title, "Tidewater Tables");
  assert.equal(document.info.Author, "Marta Quill");
  assert.equal(document.pages, 12);
  assert.equal(document.encrypted, false);
});

test("reads an information dictionary out of an object stream", async () => {
  // The path a reader working from raw bytes cannot see into, and the one where
  // the last object in the stream ends at the last byte of it.
  const pdf = objectStreamPdf({
    info: `/Title ${literal("Signal and Silt")} /Author ${literal("Piers Vale")}`,
    pages: 448,
  });

  const document = await read(pdf);
  assert.equal(document.info.Title, "Signal and Silt");
  assert.equal(document.info.Author, "Piers Vale");
  assert.equal(document.pages, 448);
});

test("decodes text strings however they were encoded", async () => {
  const utf16be = await read(
    classicPdf({ info: `/Title ${utf16("Uber allen Gipfeln")}` }),
  );
  assert.equal(utf16be.info.Title, "Uber allen Gipfeln");

  // Bytes that are valid UTF-8 without a mark to say so, which many writers
  // produce and the specification does not allow for.
  const utf8 = await read(
    classicPdf({ info: `/Title ${literal("Erklärung")}` }),
  );
  assert.equal(utf8.info.Title, "Erklärung");

  // PDFDocEncoding, which is Latin-1 except between 0x80 and 0xa0, where it
  // holds the typographic characters instead of control codes: 0x90 is a right
  // single quote and 0x92 is a trademark sign, while 0xfc is Latin-1's own u
  // with an umlaut. Getting the range wrong turns a quote in a title into a
  // stray symbol, and it is off by one glyph in either direction.
  const doc = await read(
    classicPdf({
      info: [
        "/Title ",
        pdfDocEncoded([0x54, 0x68, 0x65, 0x90, 0x73, 0x20, 0x92, 0x20, 0xfc]),
      ],
    }),
  );
  assert.equal(doc.info.Title, "The’s ™ ü");
});

test("recovers a document whose cross-reference table cannot be used", async () => {
  const info = `/Title ${literal("Kettle Logic")} /Author ${literal("Wren Ashby")}`;

  // A `startxref` pointing past the end of the file.
  const broken = await read(brokenXrefPdf({ info, pages: 189 }));
  assert.equal(broken.info.Title, "Kettle Logic");
  assert.equal(broken.pages, 189);

  // Something prepended, which shifts every offset the table recorded.
  const shifted = await read(shiftedPdf({ info, pages: 189 }));
  assert.equal(shifted.info.Title, "Kettle Logic");
  assert.equal(shifted.pages, 189);
});

test("recovers objects that exist only inside an object stream", async () => {
  const intact = objectStreamPdf({
    info: `/Title ${literal("Compressed and lost")}`,
    pages: 3,
  });

  // Break the pointer to the cross-reference stream, leaving the object stream
  // as the only place the title exists.
  const at = new TextDecoder("latin1").decode(intact).lastIndexOf("startxref");
  const broken = new Uint8Array(at + 32);
  broken.set(intact.subarray(0, at));
  broken.set(new TextEncoder().encode("startxref\n999999\n%%EOF\n"), at);

  const document = await read(broken);
  assert.equal(document.info.Title, "Compressed and lost");
});

test("is not a PDF, and says so rather than guessing", async () => {
  assert.equal(await read(new Uint8Array(0)), null);
  assert.equal(await read(new TextEncoder().encode("PK not a pdf")), null);
  assert.equal(
    await read(new Uint8Array(Array.from({ length: 4096 }, (_, i) => i & 255))),
    null,
  );
});

test("survives a truncated file without throwing", async () => {
  const whole = classicPdf({ info: `/Title ${literal("Cut short")}` });
  for (const fraction of [0.9, 0.5, 0.2, 0.02]) {
    // Whatever comes back, it must not be an exception: `sync` reads whatever
    // is in the books directory, and a half-copied file is a normal thing to
    // find there.
    await read(whole.subarray(0, Math.floor(whole.length * fraction)));
  }
});

test("turns a PDF date into ISO 8601, at whatever precision it was given", () => {
  assert.equal(pdfDate("D:20200102030405+01'00'"), "2020-01-02T03:04:05+01:00");
  assert.equal(pdfDate("D:20200102030405Z"), "2020-01-02T03:04:05Z");
  assert.equal(pdfDate("D:2020"), "2020");
  assert.equal(pdfDate("D:202001"), "2020-01");
  assert.equal(pdfDate("20200102"), "2020-01-02");
  // A zone offset with no minutes, which some writers produce.
  assert.equal(pdfDate("D:20200102030405+01"), "2020-01-02T03:04:05+01:00");
  assert.equal(pdfDate("nonsense"), null);
  assert.equal(pdfDate(""), null);
});

test("a whole generated book is a document a reader can open", async () => {
  // The other fixtures here are the smallest file that exercises one structural
  // quirk. This one is a document: pages with content streams on them, fonts,
  // an outline, and metadata in both of the places a PDF keeps it. What is being
  // checked is that a file built to be *rendered* is still a file this reader
  // can take apart — the two halves came from different requirements and only
  // agree by construction.
  const pdf = bookPdf({
    title: "On the Origin of Species",
    authors: ["Charles Darwin"],
    publisher: "John Murray",
    published: "1859",
    subjects: ["Science", "Biology"],
    description: "Variation under domestication.",
    chapters: 3,
  });

  const document = await read(pdf);

  // The information dictionary, for what it can hold.
  assert.equal(document.info.Title, "On the Origin of Species");
  assert.equal(document.info.Author, "Charles Darwin");
  // `/Producer` is the program, not the publisher, which is why the publisher
  // has to come out of the other half.
  assert.equal(document.info.Producer, "Bookshelf fixtures");

  // And XMP, for what the dictionary has no room for.
  assert.ok(document.xmp, "an XMP packet");
  assert.match(document.xmp, /<dc:publisher>/);
  assert.match(document.xmp, /John Murray/);

  // A title page plus three chapters of several pages each.
  assert.ok(document.pages > 4, `${document.pages} pages`);
  assert.equal(document.encrypted, false);
});

test("a book's page text is written in the encoding its font reads", () => {
  // A `/WinAnsiEncoding` font reads a content stream one byte at a time. An em
  // dash written as its three UTF-8 bytes is drawn as three characters, which
  // is a fixture that does not say what its own source says.
  assert.equal(winAnsi("plain ascii"), "(plain ascii)");
  assert.equal(winAnsi("a — dash"), "(a \\227 dash)");
  assert.equal(winAnsi("café"), "(caf\\351)");
  // The two characters that would end the string early.
  assert.equal(winAnsi("a (b) c"), "(a \\(b\\) c)");
  // Nothing WinAnsi can say, said as nothing rather than as mojibake.
  assert.equal(winAnsi("中"), "(?)");
});
