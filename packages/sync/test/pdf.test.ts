import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bytesSource, readPdfMetadata } from "@bookshelf/core";
import {
  classicPdf,
  literal,
  objectStreamPdf,
  xmpPacket,
} from "@bookshelf/fixtures";
import {
  findIsbn,
  isJunkTitle,
  splitAuthors,
  splitSubjects,
  xmpValues,
} from "@bookshelf/sync/metadata";
import { readPdf } from "@bookshelf/sync/pdf";

function read(bytes) {
  return readPdfMetadata(bytesSource(bytes));
}

/** Writes a fixture where `readPdf` can find it, since it takes a path. */
async function fixture(name, bytes) {
  const directory = await mkdtemp(path.join(tmpdir(), "bookshelf-test-"));
  const file = path.join(directory, name);
  await writeFile(file, bytes);
  return file;
}

test("reads every form an XMP property is written in", async () => {
  const xmp = xmpPacket(
    `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Tidal Drift in Shallow Basins</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Ilse Vantoro</rdf:li><rdf:li>Ren Calloway</rdf:li></rdf:Seq></dc:creator>
   <dc:subject><rdf:Bag><rdf:li>cs.LG</rdf:li><rdf:li>cs.AI</rdf:li></rdf:Bag></dc:subject>`,
    'dc:publisher="arXiv" dc:identifier="urn:isbn:9780000000026"',
  );

  const document = await read(classicPdf({ xmp }));
  assert.ok(document.xmp?.includes("dc:title"));

  assert.deepEqual(xmpValues(document.xmp, "dc:title"), [
    "Tidal Drift in Shallow Basins",
  ]);
  assert.deepEqual(xmpValues(document.xmp, "dc:creator"), [
    "Ilse Vantoro",
    "Ren Calloway",
  ]);
  assert.deepEqual(xmpValues(document.xmp, "dc:subject"), ["cs.LG", "cs.AI"]);
  // The attribute form, which is how single values are usually written.
  assert.deepEqual(xmpValues(document.xmp, "dc:publisher"), ["arXiv"]);

  // A request for `dc:date` must not be answered with `xmp:ModifyDate`.
  assert.deepEqual(xmpValues(document.xmp, "dc:date"), []);
});

test("an rdf:Alt is one value in several languages, not several values", () => {
  const xmp = xmpPacket(
    `   <dc:title><rdf:Alt>
     <rdf:li xml:lang="x-default">The Title</rdf:li>
     <rdf:li xml:lang="de">Der Titel</rdf:li>
   </rdf:Alt></dc:title>`,
  );
  assert.deepEqual(xmpValues(xmp, "dc:title"), ["The Title"]);
});

test("rejects a title that is really a file name or a program", () => {
  const fileName = "quarterlynotes";
  assert.equal(isJunkTitle("Acme DPA v6.4.docx"), true);
  assert.equal(isJunkTitle("Microsoft Word - acme-terms.doc"), true);
  assert.equal(isJunkTitle("untitled"), true);
  assert.equal(isJunkTitle("  "), true);
  assert.equal(isJunkTitle("Quarterly Notes", { fileName }), true);
  assert.equal(
    isJunkTitle("Skia/PDF m149", { tools: ["Skia/PDF m149"] }),
    true,
  );

  // Ugly, but it is what the document says it is called.
  assert.equal(isJunkTitle("acme-brochure-v1.3-web"), false);
  assert.equal(isJunkTitle("Signal and Silt", { fileName }), false);
});

test("only reports an ISBN whose check digit is right", () => {
  assert.equal(findIsbn(["urn:isbn:9780000000019"]), "9780000000019");
  assert.equal(findIsbn(["ISBN 978-0-00-000002-6"]), "9780000000026");
  assert.equal(findIsbn(["0-00-000001-9"]), "0000000019");
  // A thirteen-digit internal number that is not an ISBN.
  assert.equal(findIsbn(["9780000000034"]), undefined);
  assert.equal(findIsbn(["http://www.gutenberg.org/1342"]), undefined);
  assert.equal(
    findIsbn(["uuid:00000000-0000-4000-8000-000000000000"]),
    undefined,
  );
});

test("splits authors on separators that are not part of a name", () => {
  assert.deepEqual(splitAuthors("Ilse Vantoro; Ren Calloway"), [
    "Ilse Vantoro",
    "Ren Calloway",
  ]);
  assert.deepEqual(splitAuthors("Ada Lovelace and Charles Babbage"), [
    "Ada Lovelace",
    "Charles Babbage",
  ]);
  // A comma is how one name is written backwards, so it is not a separator.
  assert.deepEqual(splitAuthors("Vale, Piers"), ["Vale, Piers"]);
  assert.deepEqual(splitSubjects("cs.LG, cs.AI; cs.SE"), [
    "cs.LG",
    "cs.AI",
    "cs.SE",
  ]);
});

test("readPdf maps a document onto the metadata a book carries", async () => {
  const file = await fixture(
    "tidal-drift-preprint.pdf",
    objectStreamPdf({
      info: `/Title ${literal("tidal-drift-preprint.pdf")} /Author ${literal("Ignored")} /Keywords ${literal("cs.LG, cs.AI")} /Subject ${literal("A description of the thing.")} /CreationDate (D:20200102030405Z)`,
      xmp: xmpPacket(
        `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Tidal Drift in Shallow Basins</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Ilse Vantoro</rdf:li><rdf:li>Ren Calloway</rdf:li></rdf:Seq></dc:creator>`,
        'dc:publisher="arXiv" dc:identifier="urn:isbn:9780000000019"',
      ),
      pages: 10,
    }),
  );

  const { metadata, cover, encrypted } = await readPdf(file);

  assert.equal(metadata.title, "Tidal Drift in Shallow Basins");
  assert.deepEqual(metadata.authors, ["Ilse Vantoro", "Ren Calloway"]);
  assert.equal(metadata.publisher, "arXiv");
  assert.equal(metadata.isbn, "9780000000019");
  // `/Subject` is the description field, whatever Acrobat labels it.
  assert.equal(metadata.description, "A description of the thing.");
  assert.deepEqual(metadata.subjects, ["cs.LG", "cs.AI"]);
  assert.equal(metadata.pages, 10);
  // A creation date is the file's, not the work's, so it is kept to the day.
  assert.equal(metadata.published, "2020-01-02");
  // A PDF's cover is its first page, and rendering it is not this reader's job.
  assert.equal(cover, null);
  assert.equal(encrypted, false);
});

test("records no title at all when every candidate is a file name", async () => {
  const file = await fixture(
    "acme-dpa.pdf",
    classicPdf({ info: `/Title ${literal("Acme DPA v6.4.docx")}` }),
  );

  const { metadata } = await readPdf(file);
  // Left unset, so the caller applies the file name it would have used anyway.
  assert.equal(metadata.title, undefined);
});

test("the older dictionary wins when the XMP title is a file name", async () => {
  const file = await fixture(
    "mdb-f50329-stellenbeschreibung_2017.pdf",
    classicPdf({
      info: `/Title ${literal("Erklärung zum Beschäftigungsverhältnis")}`,
      xmp: xmpPacket(
        `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">stellenbeschreibung_2018.pdf</rdf:li></rdf:Alt></dc:title>`,
      ),
    }),
  );

  const { metadata } = await readPdf(file);
  assert.equal(metadata.title, "Erklärung zum Beschäftigungsverhältnis");
});
