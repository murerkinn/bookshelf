import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  type Book,
  CatalogService,
  readableFormat,
  resetCatalogMemo,
} from "../src/services/catalog.ts";
import { LibraryUnavailableError } from "../src/services/errors.ts";
import {
  brokenCache,
  memoryStorage,
  nullCache,
  recordingCache,
} from "./lib/storage.ts";

/**
 * The catalog is memoised in the module, which is what `resetCatalogMemo` is
 * for — without clearing it between tests, the second test would be answered
 * from the first one's library.
 */
beforeEach(resetCatalogMemo);

function book(title: string, extra: Partial<Book> = {}): Book {
  return {
    id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    authors: [],
    formats: [{ format: "epub", file: "b.epub", size: 1 }],
    ...extra,
  };
}

function library(books: readonly Book[]) {
  return { "catalog.json": JSON.stringify({ version: 1, books }) };
}

test("an unpublished catalog is an empty shelf, not an error", async () => {
  // A fresh install has no catalog at all, and the page says so rather than
  // failing — this is what lets the quickstart be run in either order.
  const { storage } = memoryStorage({});
  const catalog = new CatalogService(storage, nullCache());

  assert.deepEqual(await catalog.all(), []);
  assert.deepEqual(await catalog.search("anything"), []);
  assert.equal(await catalog.find("a-book"), null);
});

test("a corrupt catalog does not take the shelf down with it", async () => {
  const { storage } = memoryStorage({ "catalog.json": "{ not json at all" });
  const catalog = new CatalogService(storage, nullCache());

  assert.deepEqual(await catalog.all(), []);
});

test("a catalog missing its books array reads as empty", async () => {
  const { storage } = memoryStorage({ "catalog.json": '{"version":1}' });
  const catalog = new CatalogService(storage, nullCache());

  assert.deepEqual(await catalog.all(), []);
});

test("books come back sorted by title, whatever order they were published in", async () => {
  const { storage } = memoryStorage(
    library([book("Zebra"), book("apple"), book("Mango")]),
  );
  const catalog = new CatalogService(storage, nullCache());

  assert.deepEqual(
    (await catalog.all()).map((b) => b.title),
    ["apple", "Mango", "Zebra"],
  );
});

test("search looks at title, authors and publisher", async () => {
  const { storage } = memoryStorage(
    library([
      book("Essential Math", {
        authors: ["Thomas Nield"],
        publisher: "O'Reilly",
      }),
      book("Zero Trust Networks", {
        authors: ["Evan Gilman"],
        publisher: "O'Reilly",
      }),
      book("Atomic Design", { authors: ["Brad Frost"], publisher: "Self" }),
    ]),
  );
  const catalog = new CatalogService(storage, nullCache());

  const titles = async (query: string) =>
    (await catalog.search(query)).map((b) => b.title);

  assert.deepEqual(await titles("essential"), ["Essential Math"]);
  assert.deepEqual(await titles("Gilman"), ["Zero Trust Networks"]);
  assert.deepEqual(await titles("o'reilly"), [
    "Essential Math",
    "Zero Trust Networks",
  ]);
  // Case-insensitive, and surrounding space is what a search box produces.
  assert.deepEqual(await titles("  ATOMIC  "), ["Atomic Design"]);
  assert.deepEqual(await titles("nothing here"), []);
});

test("an empty query is not a search", async () => {
  const { storage } = memoryStorage(library([book("One"), book("Two")]));
  const catalog = new CatalogService(storage, nullCache());

  // The shelf renders with `?q=` present but empty, and that has to mean
  // everything rather than nothing.
  assert.equal((await catalog.search("")).length, 2);
  assert.equal((await catalog.search("   ")).length, 2);
});

test("a book is found by the id its folder is named after", async () => {
  const { storage } = memoryStorage(library([book("Essential Math")]));
  const catalog = new CatalogService(storage, nullCache());

  assert.equal((await catalog.find("essential-math"))?.title, "Essential Math");
  assert.equal(await catalog.find("no-such-book"), null);
});

test("a warm isolate answers with no reads at all", async () => {
  // Every keystroke in the search box re-renders the page, and the whole point
  // of the memo is that those renders cost nothing.
  const { storage, reads } = memoryStorage(library([book("One")]));
  const catalog = new CatalogService(storage, nullCache());

  await catalog.all();
  const afterFirst = reads.length;
  assert.equal(afterFirst, 1);

  await catalog.all();
  await catalog.search("on");
  await catalog.find("one");

  assert.equal(reads.length, afterFirst, "the memo should have answered these");
});

test("the response cache is the tier behind the memo", async () => {
  const { storage, reads } = memoryStorage(library([book("One")]));
  const { cache, calls } = recordingCache();

  await new CatalogService(storage, cache).all();
  // Looked for, missed, then filled in for the next isolate.
  assert.deepEqual(
    calls.map((c) => `${c.op}${c.op === "match" ? `:${c.hit}` : ""}`),
    ["match:false", "put"],
  );
  assert.equal(reads.length, 1);

  // A cold isolate with a warm cache: the memo is gone, so the cache answers
  // and storage is not touched again.
  resetCatalogMemo();
  const books = await new CatalogService(storage, cache).all();

  assert.deepEqual(
    books.map((b) => b.title),
    ["One"],
  );
  assert.equal(reads.length, 1, "the cache should have answered this");
});

test("the reader opens the format that renders best", () => {
  // EPUB has a real reader, a PDF goes to the browser's own viewer, and
  // anything else is a download — so the order is not arbitrary.
  // Only the formats matter here, so the rest of a book is filled in once.
  const formats = (...list: string[]): Book => ({
    ...book("Whichever"),
    formats: list.map((format) => ({ format, file: `b.${format}`, size: 1 })),
  });

  assert.equal(readableFormat(formats("pdf", "epub"))?.format, "epub");
  assert.equal(readableFormat(formats("epub"))?.format, "epub");
  assert.equal(readableFormat(formats("pdf"))?.format, "pdf");
  assert.equal(readableFormat(formats("cbz", "pdf"))?.format, "pdf");
  // An unknown format is still offered, because the alternative is a book with
  // no way to open it at all.
  assert.equal(readableFormat(formats("cbz"))?.format, "cbz");
  assert.equal(readableFormat({ ...book("Empty"), formats: [] }), undefined);
});

test("an unreachable library is not an empty one", async () => {
  // The distinction this whole path exists for. Answering with no books would
  // put "No catalog published yet" on the shelf, which is a lie about a library
  // that is sitting there intact.
  const { storage } = memoryStorage(library([book("One")]), { failing: true });
  const catalog = new CatalogService(storage, nullCache());

  await assert.rejects(catalog.all(), LibraryUnavailableError);
  await assert.rejects(catalog.search("one"), LibraryUnavailableError);
  await assert.rejects(catalog.find("one"), LibraryUnavailableError);
});

test("a catalog already read is served on when storage goes away", async (t) => {
  // Time has to move for this to mean anything: while the memo is fresh nothing
  // asks storage at all, so the interesting moment is the refresh after it
  // expires — which is the one that fails.
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

  const shelf = memoryStorage(library([book("One"), book("Two")]));
  const catalog = new CatalogService(shelf.storage, nullCache());

  assert.equal((await catalog.all()).length, 2);

  t.mock.timers.tick(61_000);
  shelf.fail();

  // An expired catalog is still made of real books, and a shelf a minute out of
  // date beats an error page.
  assert.deepEqual(
    (await catalog.all()).map((b) => b.title),
    ["One", "Two"],
  );
});

test("a failing library is asked once, not once per keystroke", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });

  const shelf = memoryStorage(library([book("One")]));
  const catalog = new CatalogService(shelf.storage, nullCache());

  await catalog.all();
  t.mock.timers.tick(61_000);
  shelf.fail();
  shelf.reads.length = 0;

  // What a reader typing in the search box produces.
  for (let i = 0; i < 8; i++) await catalog.search("on");
  assert.equal(
    shelf.reads.length,
    1,
    "a stale answer should hold off further attempts",
  );

  // It does go back, though — a stale catalog is not a permanent one.
  t.mock.timers.tick(11_000);
  await catalog.all();
  assert.equal(shelf.reads.length, 2);

  // And once storage is back, the fresh answer takes over.
  shelf.heal();
  shelf.put(
    "catalog.json",
    JSON.stringify({ version: 1, books: [book("One"), book("Three")] }),
  );
  t.mock.timers.tick(11_000);
  assert.deepEqual(
    (await catalog.all()).map((b) => b.title),
    ["One", "Three"],
  );
});

test("a broken cache costs a read, never the answer", async () => {
  const { storage, reads } = memoryStorage(library([book("One")]));
  const catalog = new CatalogService(storage, brokenCache());

  // Both halves throw: the lookup and the write that would fill it.
  assert.equal((await catalog.all()).length, 1);
  assert.equal(reads.length, 1);
});
