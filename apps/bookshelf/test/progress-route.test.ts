import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILES_FILE, progressFile } from "@bookshelf/core";
import { createServices, setServices } from "../src/services/container.ts";
import { handle } from "./lib/next-headers.ts";
import { type MemoryLibrary, memoryStorage, nullCache } from "./lib/storage.ts";

/**
 * The one route that writes, and the only one anybody can post to.
 *
 * Imported here rather than above, because it reaches `next/headers` through
 * the session, and the stand-in for that has to be in place first. The same
 * goes for the session itself.
 */
const { POST } = await import("../src/app/api/progress/route.ts");
const { PROFILE_COOKIE } = await import("../src/services/session.ts");

const SHELF = "https://shelf.test";

function library(state: Record<string, string> = {}): MemoryLibrary {
  const memory = memoryStorage({
    "catalog.json": JSON.stringify({
      version: 1,
      books: [{ id: "dracula", title: "Dracula", authors: [], formats: [] }],
    }),
    ...state,
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

  const response = await post(
    JSON.stringify({ bookId: "dracula", profileId: "default", page: 7 }),
  );

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
    JSON.stringify({
      bookId: "dracula",
      profileId: "default",
      cfi: long,
      href: long,
      page: 7,
    }),
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
          new TextEncoder().encode(
            '{"bookId":"dracula","profileId":"default","page":7}',
          ),
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
  const text = JSON.stringify({
    bookId: "dracula",
    profileId: "default",
    cfi: "x".repeat(1 << 20),
  });
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
  const response = await post(
    JSON.stringify({ bookId: "dracula", profileId: "default", page: 7 }),
    {
      "content-type": "text/plain",
      ...from("https://elsewhere.test", "cross-site"),
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(memory.writes, []);
});

test("nor can a sibling site, or an older browser on another site", async () => {
  const memory = library();
  const body = JSON.stringify({
    bookId: "dracula",
    profileId: "default",
    page: 7,
  });

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
  const body = JSON.stringify({
    bookId: "dracula",
    profileId: "default",
    page: 7,
  });

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

/** Two housemates, one of whom is a long way into the book. */
function household(): MemoryLibrary {
  return library({
    [PROFILES_FILE]: JSON.stringify({
      version: 1,
      profiles: [
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
      ],
    }),
    [progressFile("alice")]: JSON.stringify({
      version: 1,
      books: { dracula: { page: 250, updatedAt: "2020-01-01T00:00:00Z" } },
    }),
  });
}

function pageOf(memory: MemoryLibrary, profile: string): number | undefined {
  return memory.json<{ books: Record<string, { page: number }> } | null>(
    progressFile(profile),
  )?.books.dracula.page;
}

function postAs(cookie: string, profileId: string | undefined, page: number) {
  return post(JSON.stringify({ bookId: "dracula", profileId, page }), {
    cookie: `${PROFILE_COOKIE}=${cookie}`,
  });
}

test("a reader opened for one profile does not write into another's", async () => {
  const memory = household();

  // Bob's reader is still open when another tab switches this browser to
  // Alice; then Bob turns a page.
  const response = await postAs("alice", "bob", 3);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { saved: false });
  assert.equal(pageOf(memory, "alice"), 250);
  assert.equal(pageOf(memory, "bob"), undefined);
});

test("nor does a reader for a profile that has since been deleted", async () => {
  const memory = household();
  memory.put(
    PROFILES_FILE,
    JSON.stringify({ version: 1, profiles: [{ id: "alice", name: "Alice" }] }),
  );

  // The cookie still names Bob, which now resolves to Alice for a page —
  // but the reader was opened for Bob, and Alice's place is not his to move.
  const response = await postAs("bob", "bob", 3);

  assert.deepEqual(await response.json(), { saved: false });
  assert.equal(pageOf(memory, "alice"), 250);
});

test("a reader that does not say who it is for writes nothing", async () => {
  const memory = household();

  const response = await postAs("alice", undefined, 3);

  assert.deepEqual(await response.json(), { saved: false });
  assert.equal(pageOf(memory, "alice"), 250);
});

test("the profile a reader was opened for still saves", async () => {
  const memory = household();

  assert.equal((await postAs("bob", "bob", 9)).status, 200);
  assert.equal(pageOf(memory, "bob"), 9);
  assert.equal(pageOf(memory, "alice"), 250);
});
