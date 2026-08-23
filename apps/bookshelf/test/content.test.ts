import assert from "node:assert/strict";
import { test } from "node:test";
import { writeZip } from "@bookshelf/fixtures";
import { BookContentService } from "../src/services/content.ts";
import { LibraryUnavailableError } from "../src/services/errors.ts";
import {
  brokenCache,
  memoryStorage,
  must,
  nullCache,
  recordingCache,
} from "./lib/storage.ts";

const decoder = new TextDecoder();

/** An entry's text, failing the test if the entry was not there. */
function text(bytes: Uint8Array | null): string {
  return decoder.decode(must(bytes, "an entry"));
}

const CONTAINER = `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function archive(extra = []) {
  return writeZip([
    { name: "mimetype", content: "application/epub+zip" },
    { name: "META-INF/container.xml", content: CONTAINER },
    { name: "OEBPS/content.opf", content: "<package/>" },
    { name: "OEBPS/ch1.xhtml", content: "<p>the first chapter</p>" },
    ...extra,
  ]);
}

/**
 * The memo in `content.ts` is module-level and has no reset, so each test uses
 * its own key rather than sharing one — which is what a real deployment does
 * anyway, since the key is the book.
 */
let next = 0;
function key() {
  next++;
  return `book-${next}/book-${next}.epub`;
}

test("reads one file out of a book", async () => {
  const at = key();
  const { storage } = memoryStorage({ [at]: archive() });
  const content = new BookContentService(storage, nullCache());

  const bytes = await content.entry(at, "OEBPS/ch1.xhtml");
  assert.equal(text(bytes), "<p>the first chapter</p>");
});

test("locates the package document the reader is pointed at", async () => {
  const at = key();
  const { storage } = memoryStorage({ [at]: archive() });
  const content = new BookContentService(storage, nullCache());

  // Resolving this also proves the archive is readable before the reader is
  // handed anything.
  assert.equal(await content.packageDocument(at), "OEBPS/content.opf");
});

test("a book that is not there, and a book that is not a book", async () => {
  const missing = key();
  const notAnArchive = key();
  const { storage } = memoryStorage({
    [notAnArchive]: "this is not a ZIP file",
  });
  const content = new BookContentService(storage, nullCache());

  assert.equal(await content.entry(missing, "OEBPS/ch1.xhtml"), null);
  assert.equal(await content.packageDocument(missing), null);
  assert.equal(await content.entry(notAnArchive, "OEBPS/ch1.xhtml"), null);
  // Which is what the read page turns into a 404 rather than a broken reader.
  assert.equal(await content.packageDocument(notAnArchive), null);
});

test("an EPUB with no container names no package document", async () => {
  const at = key();
  const { storage } = memoryStorage({
    [at]: writeZip([{ name: "a.txt", content: "x" }]),
  });
  const content = new BookContentService(storage, nullCache());

  assert.equal(await content.packageDocument(at), null);
});

test("the archive's directory is read once, not once per chapter", async () => {
  // Reading it costs two ranged reads, and every chapter the reader opens would
  // otherwise repeat them — which is the difference between turning a page and
  // waiting on a round trip out to R2 and back.
  const at = key();
  const { storage, reads } = memoryStorage({ [at]: archive() });
  const content = new BookContentService(storage, nullCache());

  await content.entry(at, "OEBPS/ch1.xhtml");
  const afterFirst = reads.length;

  await content.entry(at, "OEBPS/content.opf");
  await content.entry(at, "mimetype");

  // Each further entry is one read of its own bytes, and nothing more.
  assert.equal(reads.length, afterFirst + 2);
  assert.equal(
    reads.filter((r) => r.op === "readRange").length,
    reads.length - reads.filter((r) => r.op === "head").length,
  );
});

test("the response cache carries the directory between isolates", async () => {
  const at = key();
  const { storage } = memoryStorage({ [at]: archive() });
  const { cache, calls } = recordingCache();

  await new BookContentService(storage, cache).entry(at, "OEBPS/ch1.xhtml");
  assert.deepEqual(
    calls.map((c) => c.op),
    ["match", "put"],
  );

  // A different service instance stands in for a cold isolate. Its memo is
  // empty, so the cache is what saves the two reads.
  const { storage: second, reads } = memoryStorage({ [at]: archive() });
  await new BookContentService(second, cache).entry(at, "OEBPS/ch1.xhtml");

  // One read for the entry itself; the directory came from the cache.
  assert.deepEqual(
    reads.map((r) => r.op),
    ["readRange"],
  );
});

test("an entry the archive does not list is not a reason to read it again", async () => {
  // An ordinary 404. Re-reading the directory on those would let any made-up
  // path cost two extra reads.
  const at = key();
  const { storage, reads } = memoryStorage({ [at]: archive() });
  const content = new BookContentService(storage, nullCache());

  await content.entry(at, "OEBPS/ch1.xhtml");
  const afterFirst = reads.length;

  assert.equal(await content.entry(at, "OEBPS/invented.xhtml"), null);
  assert.equal(await content.entry(at, "../../etc/passwd"), null);

  assert.equal(
    reads.length,
    afterFirst,
    "no re-read for a path that is absent",
  );
});

test("a republished book is re-read rather than served from a stale directory", async () => {
  // The case this exists for: the app memoises a directory per book, and
  // republishing replaces the object at the same key. A stale offset would
  // either fail or, worse, serve some other part of the file as a chapter.
  const at = key();
  const library = memoryStorage({ [at]: archive() });
  const content = new BookContentService(library.storage, nullCache());

  assert.equal(
    text(await content.entry(at, "OEBPS/ch1.xhtml")),
    "<p>the first chapter</p>",
  );

  // The same book, republished with an entry in front of it, so every offset
  // the memoised directory recorded is now wrong.
  const republished = writeZip([
    {
      name: "an-entry-added-in-front-of-everything-else.txt",
      content: "x".repeat(500),
    },
    { name: "mimetype", content: "application/epub+zip" },
    { name: "META-INF/container.xml", content: CONTAINER },
    { name: "OEBPS/content.opf", content: "<package/>" },
    { name: "OEBPS/ch1.xhtml", content: "<p>the revised chapter</p>" },
  ]);
  library.put(at, republished);

  assert.equal(
    text(await content.entry(at, "OEBPS/ch1.xhtml")),
    "<p>the revised chapter</p>",
  );
});

test("a book replaced by something unreadable stops answering", async () => {
  const at = key();
  const library = memoryStorage({ [at]: archive() });
  const content = new BookContentService(library.storage, nullCache());

  await content.entry(at, "OEBPS/ch1.xhtml");

  // Not an archive any more, so the re-read finds no directory either.
  library.put(at, "truncated mid-upload");
  assert.equal(await content.entry(at, "OEBPS/ch1.xhtml"), null);
});

test("more books than the memo holds still all read correctly", async () => {
  // The memo is bounded to keep isolate memory in check, so the oldest book
  // falls out. Falling out must cost a read, not an answer.
  const keys = Array.from({ length: 12 }, () => key());
  const objects = Object.fromEntries(keys.map((k) => [k, archive()]));
  const { storage } = memoryStorage(objects);
  const content = new BookContentService(storage, nullCache());

  for (const k of keys) {
    assert.equal(
      text(await content.entry(k, "OEBPS/ch1.xhtml")),
      "<p>the first chapter</p>",
    );
  }

  // Back to the first one, whose directory has since been evicted.
  assert.equal(
    text(await content.entry(keys[0], "OEBPS/ch1.xhtml")),
    "<p>the first chapter</p>",
  );
});

test("an unreachable book is not a missing one", async () => {
  // Null means this book does not have that entry, which is a 404. An outage is
  // not, and telling them apart is what keeps a reader from giving up on a
  // chapter that is only briefly out of reach.
  const at = key();
  const library = memoryStorage({ [at]: archive() });
  const content = new BookContentService(library.storage, nullCache());

  library.fail();
  await assert.rejects(
    content.entry(at, "OEBPS/ch1.xhtml"),
    LibraryUnavailableError,
  );
  await assert.rejects(content.packageDocument(at), LibraryUnavailableError);
});

test("a book already open keeps reading when the cache breaks", async () => {
  const at = key();
  const { storage } = memoryStorage({ [at]: archive() });
  const content = new BookContentService(storage, brokenCache());

  assert.equal(
    text(await content.entry(at, "OEBPS/ch1.xhtml")),
    "<p>the first chapter</p>",
  );
});
