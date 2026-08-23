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

function library(): MemoryLibrary {
  const memory = memoryStorage({
    [BOOK]: TEXT,
    [COVER]: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
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

test("?inline serves a book the browser can display itself", async () => {
  library();
  const response = await ask(download, BOOK, { query: "?inline=1" });

  assert.match(response.headers.get("content-disposition") ?? "", /^inline; /);
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
