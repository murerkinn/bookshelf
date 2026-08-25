import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as cover } from "../src/app/cover/[...key]/route.ts";
import { GET as download } from "../src/app/download/[...key]/route.ts";
import { serviceUnavailable } from "../src/lib/http.ts";
import { createServices, setServices } from "../src/services/container.ts";
import { LibraryUnavailableError } from "../src/services/errors.ts";
import { type MemoryLibrary, memoryStorage, nullCache } from "./lib/storage.ts";

/**
 * The two routes that read storage directly.
 *
 * Everything else goes through a service, and the services are tested against
 * the provider contract elsewhere. These two answer the provider themselves
 * because what they serve is shaped by the object's own metadata — its length,
 * its validator — so they are the only place where the wire-level part of that
 * contract is decided: which status, which headers, and which of those three
 * states the library was in.
 */

const BOOK = "dracula/dracula.epub";
const COVER = "dracula/cover.webp";
const TEXT = "the whole of a very short book";

/** What the app writes back into the same library the books are in. */
const PROFILES = ".bookshelf/profiles.json";
const POSITIONS = ".bookshelf/progress/someone.json";

function library(): MemoryLibrary {
  const memory = memoryStorage({
    [BOOK]: TEXT,
    [COVER]: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    [PROFILES]: '{"version":1,"profiles":[{"id":"someone"}]}',
    [POSITIONS]: '{"version":1,"books":{"dracula":{"page":42}}}',
  });
  setServices(createServices(memory.storage, nullCache()));
  return memory;
}

/**
 * A request to one of these routes, with its path already split.
 *
 * Generic over the context type because each route is typed against its own
 * generated `RouteContext`, and the two are not interchangeable. What is built
 * here is what Next would have passed either of them.
 */
function ask<C>(
  route: (request: Request, ctx: C) => Promise<Response>,
  key: string,
  { query = "", ...init }: RequestInit & { query?: string } = {},
): Promise<Response> {
  return route(new Request(`https://shelf.test/x/${key}${query}`, init), {
    params: Promise.resolve({ key: key.split("/") }),
  } as C);
}

test.afterEach(() => setServices(null));

test("a download is the whole book, and says so", async () => {
  library();
  const response = await ask(download, BOOK);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("content-length"), String(TEXT.length));
  assert.match(
    response.headers.get("content-disposition") ?? "",
    /^attachment; filename="dracula\.epub"/,
  );
  assert.equal(await response.text(), TEXT);
});

test("a range is served as a range", async () => {
  library();
  const response = await ask(download, BOOK, {
    headers: { range: "bytes=4-11" },
  });

  assert.equal(response.status, 206);
  assert.equal(
    response.headers.get("content-range"),
    `bytes 4-11/${TEXT.length}`,
  );
  assert.equal(response.headers.get("content-length"), "8");
  assert.equal(await response.text(), TEXT.slice(4, 12));
});

test("a range past the end names the length rather than serving bytes", async () => {
  library();
  const response = await ask(download, BOOK, {
    headers: { range: `bytes=${TEXT.length + 10}-` },
  });

  assert.equal(response.status, 416);
  assert.equal(response.headers.get("content-range"), `bytes */${TEXT.length}`);
  assert.equal(await response.text(), "");
});

test("a resumed download of a book that has changed starts again", async () => {
  const memory = library();
  const etag = (await ask(download, BOOK)).headers.get("etag");
  memory.put(BOOK, "a different book entirely, republished under the same key");

  const response = await ask(download, BOOK, {
    headers: { range: "bytes=0-3", "if-range": etag ?? "" },
  });

  // 200, not 206: splicing four bytes of the old file onto the new one would
  // hand back something that was never a book.
  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    "a different book entirely, republished under the same key",
  );
});

test("a caller that already holds this book is told so", async () => {
  library();
  const etag = (await ask(download, BOOK)).headers.get("etag");
  const response = await ask(download, BOOK, {
    headers: { "if-none-match": etag ?? "" },
  });

  assert.equal(response.status, 304);
  assert.equal(await response.text(), "");
});

test("a book that is not there is not there", async () => {
  library();
  assert.equal((await ask(download, "nobody/nothing.epub")).status, 404);
});

/**
 * The route's key used to be whatever the URL said, which made it a read of any
 * object the provider would answer for. The app's own state shares the library
 * with the books: one of these names everyone reading here, the other says what
 * one of them reads and where they are. Neither is a book.
 */
test("the app's own state is not downloadable", async () => {
  const memory = library();

  for (const key of [PROFILES, POSITIONS, "catalog.json"]) {
    const response = await ask(download, key);
    assert.equal(response.status, 404, key);
    assert.equal(await response.text(), "Not found");
  }

  // Refused before the provider is asked, so a key that is not a book's costs
  // no read at all.
  assert.deepEqual(memory.reads, []);
});

test("a key that is not a book's is not a key", async () => {
  library();

  for (const key of [
    "dracula",
    "dracula/../.bookshelf/profiles.json",
    "../catalog.json",
    "dracula/chapters/one.xhtml",
    "Dracula/dracula.epub",
  ]) {
    assert.equal((await ask(download, key)).status, 404, key);
  }
});

test("the app's own state is not a cover either", async () => {
  library();
  assert.equal((await ask(cover, PROFILES)).status, 404);
});

/**
 * An inline disposition asks the browser to render the object in this origin.
 * The type comes from the provider, and the bucket is not necessarily only ever
 * written by the sync tool, so the ones that would run script here are served
 * as attachments however the URL asked.
 */
test("?inline is honoured for what the browser can render, and refused for the rest", async () => {
  const memory = memoryStorage({
    "dracula/dracula.pdf": TEXT,
    "dracula/dracula.html": "<script>fetch('/api/progress')</script>",
  });
  setServices(createServices(memory.storage, nullCache()));

  const pdf = await ask(download, "dracula/dracula.pdf", {
    query: "?inline=1",
  });
  assert.match(pdf.headers.get("content-disposition") ?? "", /^inline; /);

  // `contentTypeFor` has no entry for `.html`, so this arrives as
  // octet-stream — which is exactly the case `nosniff` is for, and it is still
  // not something to hand this origin inline.
  const html = await ask(download, "dracula/dracula.html", {
    query: "?inline=1",
  });
  assert.match(html.headers.get("content-disposition") ?? "", /^attachment; /);
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
});

test("bytes are served as the type they were stated to be", async () => {
  library();
  assert.equal(
    (await ask(download, BOOK)).headers.get("x-content-type-options"),
    "nosniff",
  );
  assert.equal(
    (await ask(cover, COVER)).headers.get("x-content-type-options"),
    "nosniff",
  );
});

/**
 * The distinction the whole error path exists for. A 404 tells a reader the
 * book is gone and a client to stop asking; both are wrong when the shelf is
 * merely unreachable, and both used to be the answer.
 */
test("a library that cannot be reached is an outage, not a missing book", async () => {
  const memory = library();
  memory.fail();

  const response = await ask(download, BOOK);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("an outage during a ranged download is an outage too", async () => {
  const memory = library();
  memory.fail();

  // The look at the object's length comes first and fails first, which is a
  // different call site to the read above.
  const response = await ask(download, BOOK, {
    headers: { range: "bytes=0-3" },
  });
  assert.equal(response.status, 503);
});

test("a cover is served, cached and validated", async () => {
  library();
  const response = await ask(cover, COVER);

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("cache-control") ?? "",
    /^public, max-age=/,
  );
  assert.ok(response.headers.get("etag"));
});

test("a cover that cannot be reached is not cached as a book with no cover", async () => {
  const memory = library();
  memory.fail();

  const response = await ask(cover, COVER);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("only images are served as covers", async () => {
  library();
  assert.equal((await ask(cover, BOOK)).status, 404);
});

test("a bug is not dressed up as an outage", () => {
  const bug = new TypeError("undefined is not a function");
  assert.throws(() => serviceUnavailable(bug), bug);
  assert.equal(
    serviceUnavailable(new LibraryUnavailableError("reading a book", null))
      .status,
    503,
  );
});
