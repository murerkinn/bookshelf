import assert from "node:assert/strict";
import { test } from "node:test";
import { GET as book } from "../src/app/book/[...path]/route.ts";
import { GET as cover } from "../src/app/cover/[...key]/route.ts";
import { GET as download } from "../src/app/download/[...key]/route.ts";
import { checkRateLimit } from "../src/services/adapters/workers-rate-limit.ts";
import { createServices, setServices } from "../src/services/container.ts";
import { NoLimits } from "../src/services/ports/limits.ts";
import {
  type MemoryLibrary,
  memoryStorage,
  nullCache,
  recordingCache,
  recordingLimits,
} from "./lib/storage.ts";

/**
 * What the limiters are for: R2 is reachable only through this Worker, the
 * Worker is public and unauthenticated, and the bucket's allowance is finite.
 *
 * So these tests are about arithmetic rather than about bytes. Two things have
 * to hold for the limit to mean anything — that a refused request never reaches
 * the bucket, and that every request which *tries* to reach it is counted, in
 * particular the ones that then fail. And one thing has to hold for the shelf
 * to stay usable: that a request the cache answered, or that was never going to
 * touch R2 at all, costs a visitor nothing.
 */

const BOOK = "dracula/dracula.epub";
const COVER = "dracula/cover.webp";
const TEXT = "the whole of a very short book";

/** The address Cloudflare puts on a request, and the only key that counts. */
const VISITOR = "203.0.113.7";

function library(): MemoryLibrary {
  return memoryStorage({
    [BOOK]: TEXT,
    [COVER]: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
  });
}

/**
 * A request as it arrives at the Worker, which is to say one carrying the header
 * Cloudflare sets and the client cannot.
 */
function from(visitor: string | null, init: RequestInit = {}): RequestInit {
  return visitor
    ? { ...init, headers: { ...init.headers, "CF-Connecting-IP": visitor } }
    : init;
}

/** A GET at one of the byte routes, with its path already split as Next does. */
function ask<C>(
  route: (request: Request, ctx: C) => Promise<Response>,
  key: string,
  {
    query = "",
    param = "key",
    ...init
  }: RequestInit & {
    query?: string;
    param?: string;
  } = {},
): Promise<Response> {
  return route(new Request(`https://shelf.test/x/${key}${query}`, init), {
    params: Promise.resolve({ [param]: key.split("/") }),
  } as C);
}

test.afterEach(() => setServices(null));

test("a visitor over the allowance is refused before the bucket is read", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits({ r2: 0 });
  setServices(createServices(memory.storage, nullCache(), limits));

  const response = await ask(download, BOOK, from(VISITOR));

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(await response.text(), "Too many requests");

  // The whole point: nothing was asked of storage.
  assert.deepEqual(memory.reads, []);
  // And the refusal was counted against the address Cloudflare supplied.
  assert.deepEqual(asked, [{ allowance: "r2", visitor: VISITOR }]);
});

test("a download is weighed against both allowances, the cheap one first", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits();
  setServices(createServices(memory.storage, nullCache(), limits));

  const response = await ask(download, BOOK, from(VISITOR));

  assert.equal(response.status, 200);
  assert.deepEqual(asked, [
    { allowance: "r2", visitor: VISITOR },
    { allowance: "download", visitor: VISITOR },
  ]);
});

test("over the R2 allowance, the download allowance is never spent", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits({ r2: 0, download: 0 });
  setServices(createServices(memory.storage, nullCache(), limits));

  await ask(download, BOOK, from(VISITOR));

  // Refused at the first gate, so the second was not reached. Otherwise a
  // visitor already over one limit would burn through the other as well.
  assert.deepEqual(asked, [{ allowance: "r2", visitor: VISITOR }]);
});

test("over the download allowance, the book is not read", async () => {
  const memory = library();
  const { limits } = recordingLimits({ download: 0 });
  setServices(createServices(memory.storage, nullCache(), limits));

  const response = await ask(download, BOOK, from(VISITOR));

  assert.equal(response.status, 429);
  assert.deepEqual(memory.reads, []);
});

test("a range is not a download, so a book can still be read a page at a time", async () => {
  const memory = library();
  // Nothing left of the download allowance at all: a PDF reader fetching this
  // URL a slice at a time must not be stopped by it, or a book becomes
  // unreadable after ten pages.
  const { limits, asked } = recordingLimits({ download: 0 });
  setServices(createServices(memory.storage, nullCache(), limits));

  const response = await ask(
    download,
    BOOK,
    from(VISITOR, { headers: { range: "bytes=4-11" } }),
  );

  assert.equal(response.status, 206);
  assert.deepEqual(asked, [{ allowance: "r2", visitor: VISITOR }]);
});

test("a request that fails at the bucket has still spent its allowance", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits();
  setServices(createServices(memory.storage, nullCache(), limits));
  memory.fail();

  const response = await ask(download, BOOK, from(VISITOR));

  // What is being limited is R2 access attempted, not bytes served — so an
  // outage, or a client that hangs up, is not a free retry.
  assert.equal(response.status, 503);
  assert.equal(asked.length, 2);
});

test("a key that names no book never reaches the limiter", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits();
  setServices(createServices(memory.storage, nullCache(), limits));

  const response = await ask(
    download,
    ".bookshelf/profiles.json",
    from(VISITOR),
  );

  assert.equal(response.status, 404);
  // Refused on its shape, before any of this. A request that was never going to
  // touch R2 does not get to spend a visitor's minute.
  assert.deepEqual(asked, []);
});

test("a cover the cache already holds costs nothing", async () => {
  const memory = library();
  const { cache } = recordingCache();
  const { limits, asked } = recordingLimits();
  setServices(createServices(memory.storage, cache, limits));

  const first = await ask(cover, COVER, from(VISITOR));
  assert.equal(first.status, 200);
  assert.equal(asked.length, 1);

  const second = await ask(cover, COVER, from(VISITOR));
  assert.equal(second.status, 200);
  // Answered from the cache, so the bucket was untouched and so was the
  // allowance. A shelf of twenty covers would otherwise cost twenty a view.
  assert.equal(asked.length, 1);
});

test("a chapter read out of the archive is counted", async () => {
  const memory = memoryStorage({ [BOOK]: TEXT });
  const { cache } = recordingCache();
  const { limits, asked } = recordingLimits();
  setServices(createServices(memory.storage, cache, limits));

  // Not a real archive, so this 404s — which is beside the point. What matters
  // is that it was counted, having genuinely gone looking in the bucket.
  await ask(book, `${BOOK}/OEBPS/ch1.xhtml`, {
    ...from(VISITOR),
    param: "path",
  });
  assert.deepEqual(asked, [{ allowance: "r2", visitor: VISITOR }]);
});

test("everything with no address of its own shares one bucket", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits();
  setServices(createServices(memory.storage, nullCache(), limits));

  await ask(download, BOOK, from(null));

  // Not a request that came through Cloudflare — a health check, `next dev`,
  // this test — and none of those is the public internet.
  assert.deepEqual(asked[0], { allowance: "r2", visitor: "unknown" });
});

test("a runtime with no limiter serves the library unchanged", async () => {
  const memory = library();
  setServices(createServices(memory.storage, nullCache(), new NoLimits()));

  const response = await ask(download, BOOK, from(VISITOR));

  // The filesystem provider, and `next dev`. Both have no binding and neither
  // needs one; what they must not do is refuse to serve a book.
  assert.equal(response.status, 200);
  assert.equal(await response.text(), TEXT);
});

test("a limiter that is broken lets the request through", async () => {
  const allowed = await checkRateLimit(
    {
      limit() {
        return Promise.reject(new Error("the limiter is unreachable"));
      },
    },
    VISITOR,
  );

  // Failing closed would answer 429 to everyone in the colo for as long as the
  // fault lasted, which is a worse outage than the one being guarded against.
  assert.equal(allowed, true);
});

test("a limiter is asked about one visitor at a time", async () => {
  const memory = library();
  const { limits, asked } = recordingLimits({ r2: 1 });
  setServices(createServices(memory.storage, nullCache(), limits));

  const mine = await ask(download, BOOK, from(VISITOR));
  const theirs = await ask(download, BOOK, from("198.51.100.9"));

  assert.equal(mine.status, 200);
  // The fake counts one allowance for every visitor, which is not what the
  // binding does — the point here is only that it was told who was asking.
  assert.equal(theirs.status, 429);
  assert.deepEqual(
    asked.map((one) => one.visitor),
    [VISITOR, VISITOR, "198.51.100.9"],
  );
});
