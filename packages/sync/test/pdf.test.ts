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
    `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Auto: The AGI Compiler</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jaber Jaber</rdf:li><rdf:li>Osama Jaber</rdf:li></rdf:Seq></dc:creator>
   <dc:subject><rdf:Bag><rdf:li>cs.LG</rdf:li><rdf:li>cs.AI</rdf:li></rdf:Bag></dc:subject>`,
    'dc:publisher="arXiv" dc:identifier="urn:isbn:9781449358068"',
  );

  const document = await read(classicPdf({ xmp }));
  assert.ok(document.xmp?.includes("dc:title"));

  assert.deepEqual(xmpValues(document.xmp, "dc:title"), [
    "Auto: The AGI Compiler",
  ]);
  assert.deepEqual(xmpValues(document.xmp, "dc:creator"), [
    "Jaber Jaber",
    "Osama Jaber",
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
  const fileName = "resumepages";
  assert.equal(isJunkTitle("Cloudflare DPA v6.4.docx"), true);
  assert.equal(isJunkTitle("Microsoft Word - contract.doc"), true);
  assert.equal(isJunkTitle("untitled"), true);
  assert.equal(isJunkTitle("  "), true);
  assert.equal(isJunkTitle("Resume Pages", { fileName }), true);
  assert.equal(
    isJunkTitle("Skia/PDF m149", { tools: ["Skia/PDF m149"] }),
    true,
  );

  // Ugly, but it is what the document says it is called.
  assert.equal(isJunkTitle("coyotiv-brochure-v1.3-web"), false);
  assert.equal(isJunkTitle("RESTful Web Services", { fileName }), false);
});

test("only reports an ISBN whose check digit is right", () => {
  assert.equal(findIsbn(["urn:isbn:9781098102937"]), "9781098102937");
  assert.equal(findIsbn(["ISBN 978-1-4493-5806-8"]), "9781449358068");
  assert.equal(findIsbn(["0-596-52926-0"]), "0596529260");
  // A thirteen-digit internal number that is not an ISBN.
  assert.equal(findIsbn(["9781098102938"]), undefined);
  assert.equal(findIsbn(["http://www.gutenberg.org/1342"]), undefined);
  assert.equal(
    findIsbn(["uuid:5f8c1a2e-0000-4000-8000-000000000000"]),
    undefined,
  );
});

test("splits authors on separators that are not part of a name", () => {
  assert.deepEqual(splitAuthors("Jaber Jaber; Osama Jaber"), [
    "Jaber Jaber",
    "Osama Jaber",
  ]);
  assert.deepEqual(splitAuthors("Ada Lovelace and Charles Babbage"), [
    "Ada Lovelace",
    "Charles Babbage",
  ]);
  // A comma is how one name is written backwards, so it is not a separator.
  assert.deepEqual(splitAuthors("Richardson, Leonard"), [
    "Richardson, Leonard",
  ]);
  assert.deepEqual(splitSubjects("cs.LG, cs.AI; cs.SE"), [
    "cs.LG",
    "cs.AI",
    "cs.SE",
  ]);
});

test("readPdf maps a document onto the metadata a book carries", async () => {
  const file = await fixture(
    "auto-agi-compiler-article.pdf",
    objectStreamPdf({
      info: `/Title ${literal("auto-agi-compiler-article.pdf")} /Author ${literal("Ignored")} /Keywords ${literal("cs.LG, cs.AI")} /Subject ${literal("A description of the thing.")} /CreationDate (D:20260707025135Z)`,
      xmp: xmpPacket(
        `   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Auto: The AGI Compiler</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jaber Jaber</rdf:li><rdf:li>Osama Jaber</rdf:li></rdf:Seq></dc:creator>`,
        'dc:publisher="arXiv" dc:identifier="urn:isbn:9781098102937"',
      ),
      pages: 10,
    }),
  );

  const { metadata, cover, encrypted } = await readPdf(file);

  assert.equal(metadata.title, "Auto: The AGI Compiler");
  assert.deepEqual(metadata.authors, ["Jaber Jaber", "Osama Jaber"]);
  assert.equal(metadata.publisher, "arXiv");
  assert.equal(metadata.isbn, "9781098102937");
  // `/Subject` is the description field, whatever Acrobat labels it.
  assert.equal(metadata.description, "A description of the thing.");
  assert.deepEqual(metadata.subjects, ["cs.LG", "cs.AI"]);
  assert.equal(metadata.pages, 10);
  // A creation date is the file's, not the work's, so it is kept to the day.
  assert.equal(metadata.published, "2026-07-07");
  // A PDF's cover is its first page, and rendering it is not this reader's job.
  assert.equal(cover, null);
  assert.equal(encrypted, false);
});

test("records no title at all when every candidate is a file name", async () => {
  const file = await fixture(
    "cloudflare-dpa.pdf",
    classicPdf({ info: `/Title ${literal("Cloudflare DPA v6.4.docx")}` }),
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
