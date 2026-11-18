import assert from "node:assert/strict";
import { test } from "node:test";
import { progressFile } from "@bookshelf/core";
import { createServices, setServices } from "../src/services/container.ts";
import { handle } from "./lib/next-headers.ts";
import { type MemoryLibrary, memoryStorage, nullCache } from "./lib/storage.ts";

/**
 * The one route that writes, and the only one anybody can post to.
 *
 * Imported here rather than above, because it reaches `next/headers` through
 * the session, and the stand-in for that has to be in place first.
 */
const { POST } = await import("../src/app/api/progress/route.ts");

const SHELF = "https://shelf.test";

function library(): MemoryLibrary {
  const memory = memoryStorage({
    "catalog.json": JSON.stringify({
      version: 1,
      books: [{ id: "dracula", title: "Dracula", authors: [], formats: [] }],
    }),
  });
  setServices(createServices(memory.storage, nullCache()));
  return memory;
}

function post(body: BodyInit, headers: HeadersInit = {}): Promise<Response> {
  return handle(
    POST,
    new Request(`${SHELF}/api/progress`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

test.afterEach(() => setServices(null));

test("a position is saved for the profile reading", async () => {
  const memory = library();

  const response = await post(JSON.stringify({ bookId: "dracula", page: 7 }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { saved: true });
  assert.equal(
    memory.json<{ books: Record<string, { page: number }> }>(
      progressFile("default"),
    ).books.dracula.page,
    7,
  );
});

test("the longest real position still fits", async () => {
  const memory = library();
  // Every field at the length the route keeps, in characters that take three
  // bytes each: more than any reader sends, and still a position.
  const long = "書".repeat(1024);

  const response = await post(
    JSON.stringify({ bookId: "dracula", cfi: long, href: long, page: 7 }),
  );

  assert.equal(response.status, 200);
  assert.equal(memory.writes.length, 1);
});

test("a body that says it is too long is refused unread", async () => {
  const memory = library();
  let pulled = false;
  // A post that would be saved if it were read. No high-water mark, so the
  // stream is only pulled when something reads it.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(
          new TextEncoder().encode('{"bookId":"dracula","page":7}'),
        );
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );

  const response = await handle(
    POST,
    new Request(`${SHELF}/api/progress`, {
      method: "POST",
      headers: { "content-length": String(8 * 1024 * 1024) },
      body,
      duplex: "half",
    } as RequestInit),
  );

  assert.equal(response.status, 413);
  assert.equal(pulled, false);
  assert.deepEqual(memory.writes, []);
});

test("a body that turns out too long is refused before it is all read", async () => {
  const memory = library();

  // A valid post with a megabyte of padding in a field the route would
  // otherwise truncate — so without a limit it is parsed whole, then saved.
  const text = JSON.stringify({ bookId: "dracula", cfi: "x".repeat(1 << 20) });
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 4096;
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes.byteLength) return controller.close();
      controller.enqueue(bytes.subarray(sent, sent + CHUNK));
      sent += CHUNK;
    },
    cancel() {
      cancelled = true;
    },
  });

  // Chunked, so there is no length to go on but the count.
  const response = await handle(
    POST,
    new Request(`${SHELF}/api/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );

  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.ok(sent < 64 * 1024, `read ${sent} bytes of ${bytes.byteLength}`);
  assert.deepEqual(memory.writes, []);
});

/** What a browser adds to a post, as the page that made it would have it. */
function from(origin: string, site?: string): Record<string, string> {
  return {
    host: "shelf.test",
    origin,
    ...(site ? { "sec-fetch-site": site } : {}),
  };
}

test("another site's page cannot post a position", async () => {
  const memory = library();

  // A form or a no-cors fetch: no preflight, so nothing but the route stands
  // between that page and a shelf on the visitor's network.
  const response = await post(JSON.stringify({ bookId: "dracula", page: 7 }), {
    "content-type": "text/plain",
    ...from("https://elsewhere.test", "cross-site"),
  });

  assert.equal(response.status, 403);
  assert.deepEqual(memory.writes, []);
});

test("nor can a sibling site, or an older browser on another site", async () => {
  const memory = library();
  const body = JSON.stringify({ bookId: "dracula", page: 7 });

  for (const headers of [
    from("https://other.shelf.test", "same-site"),
    from("https://elsewhere.test"),
    from("null"),
  ]) {
    assert.equal((await post(body, headers)).status, 403, headers.origin);
  }
  assert.deepEqual(memory.writes, []);
});

test("the reader's own posts and beacons still arrive", async () => {
  const memory = library();
  const body = JSON.stringify({ bookId: "dracula", page: 7 });

  for (const headers of [
    // What a browser sends with the reader's fetch and its pagehide beacon.
    from(SHELF, "same-origin"),
    // A browser too old to say, judged by its origin instead.
    from(SHELF),
    // The same behind a proxy that says which host it was asked for.
    { ...from("https://books.example"), "x-forwarded-host": "books.example" },
  ]) {
    assert.equal((await post(body, headers)).status, 200, headers.origin);
  }
  assert.equal(memory.writes.length, 3);
});
