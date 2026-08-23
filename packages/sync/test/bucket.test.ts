import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { syncLibrary } from "@bookshelf/sync/bucket";

/**
 * A destination that records what was done to it.
 *
 * `list` and `removeAll` are the optional halves of the provider contract, and
 * the whole point of the tests below is what happens when a provider has them
 * and when it does not — so they are added only when asked for, exactly as a
 * real provider leaves them undefined.
 */
function fakeAdmin({
  objects = {},
  canList = false,
  canRemoveAll = false,
} = {}) {
  const held = new Map(Object.entries(objects));
  const put = [];
  const removed = [];

  const admin = {
    name: "a fake destination",
    async read(key) {
      const value = held.get(key);
      return value === undefined ? null : new TextEncoder().encode(value);
    },
    async put(key, file, contentType) {
      put.push({ key, file, contentType });
      held.set(key, "uploaded");
    },
    async remove(key) {
      removed.push(key);
      held.delete(key);
    },
  };

  if (canList) admin.list = async () => [...held.keys()];
  if (canRemoveAll) {
    admin.removeAll = async () => {
      const count = held.size;
      held.clear();
      return count;
    };
  }

  return { admin, put, removed, held };
}

/** A built tree on disk, as `buildLibrary` would have left it. */
async function tree(files) {
  const output = await mkdtemp(path.join(tmpdir(), "bookshelf-sync-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(output, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return output;
}

const LIBRARY = {
  "catalog.json":
    '{"version":1,"books":[{"id":"a-book","cover":"cover.webp","formats":[{"file":"a-book.epub"}]}]}',
  "a-book/metadata.json": "{}",
  "a-book/cover.webp": "webp bytes",
  "a-book/a-book.epub": "epub bytes",
};

function run(admin, output, options = {}) {
  return syncLibrary(admin, output, { log: () => {}, ...options });
}

test("uploads every file in the built tree", async () => {
  const output = await tree(LIBRARY);
  const { admin, put } = fakeAdmin();

  const result = await run(admin, output);

  assert.equal(result.uploaded, 4);
  assert.equal(result.failed, 0);
  assert.deepEqual(put.map((p) => p.key).sort(), [
    "a-book/a-book.epub",
    "a-book/cover.webp",
    "a-book/metadata.json",
    "catalog.json",
  ]);
});

test("gives each object a content type from its name", async () => {
  const output = await tree(LIBRARY);
  const { admin, put } = fakeAdmin();

  await run(admin, output);

  const byKey = Object.fromEntries(put.map((p) => [p.key, p.contentType]));
  assert.equal(byKey["catalog.json"], "application/json");
  assert.equal(byKey["a-book/a-book.epub"], "application/epub+zip");
  assert.equal(byKey["a-book/cover.webp"], "image/webp");
});

test("removes what the library no longer holds", async () => {
  // Deleting a book locally has to delete it remotely, or the shelf keeps
  // serving something the library does not have.
  const output = await tree(LIBRARY);
  const { admin, removed } = fakeAdmin({
    canList: true,
    objects: {
      "catalog.json": "{}",
      "a-book/a-book.epub": "still wanted",
      "gone-book/metadata.json": "orphan",
      "gone-book/gone-book.epub": "orphan",
    },
  });

  const result = await run(admin, output);

  assert.deepEqual(removed.sort(), [
    "gone-book/gone-book.epub",
    "gone-book/metadata.json",
  ]);
  assert.equal(result.removed, 2);
  // A provider that can enumerate gives an exact answer.
  assert.equal(result.exact, true);
});

test("a provider that cannot enumerate falls back to the published catalog", async () => {
  // Which is exact for a destination only this script manages, and blind to
  // anything put there by other means — so it says so.
  const output = await tree(LIBRARY);
  const { admin, removed } = fakeAdmin({
    objects: {
      "catalog.json": JSON.stringify({
        books: [
          {
            id: "gone-book",
            cover: "cover.webp",
            formats: [{ file: "gone-book.epub" }],
          },
        ],
      }),
      "put-there-by-hand.txt": "not in any catalog",
    },
  });

  const result = await run(admin, output);

  // Everything the previous catalog described, and nothing it did not.
  assert.deepEqual(removed.sort(), [
    "gone-book/cover.webp",
    "gone-book/gone-book.epub",
    "gone-book/metadata.json",
  ]);
  assert.equal(result.exact, false);
  // The object nobody recorded is left alone rather than guessed at.
  assert.ok(!removed.includes("put-there-by-hand.txt"));
});

test("a destination with no previous catalog has nothing to remove", async () => {
  const output = await tree(LIBRARY);
  const { admin, removed } = fakeAdmin();

  const result = await run(admin, output);

  assert.deepEqual(removed, []);
  assert.equal(result.removed, 0);
  assert.equal(result.uploaded, 4);
});

test("an unreadable previous catalog is treated as nothing known", async () => {
  const output = await tree(LIBRARY);
  const { admin, removed } = fakeAdmin({
    objects: { "catalog.json": "{ this is not json" },
  });

  const result = await run(admin, output);

  // Better to leave objects behind than to delete on the strength of a file
  // that could not be parsed.
  assert.deepEqual(removed, []);
  assert.equal(result.uploaded, 4);
  assert.equal(result.exact, false);
});

test("force clears the destination when the provider can", async () => {
  const output = await tree(LIBRARY);
  const { admin, removed } = fakeAdmin({
    canList: true,
    canRemoveAll: true,
    objects: { "catalog.json": "{}", "stale/thing.epub": "x" },
  });

  const result = await run(admin, output, { force: true });

  assert.equal(result.removed, 2);
  assert.equal(result.exact, true);
  // Cleared wholesale rather than key by key.
  assert.deepEqual(removed, []);
  assert.equal(result.uploaded, 4);
});

test("force without a wipe clears only what was recorded, and says so", async () => {
  const output = await tree(LIBRARY);
  const { admin, removed } = fakeAdmin({
    objects: {
      "catalog.json": JSON.stringify({
        books: [{ id: "a-book", formats: [{ file: "a-book.epub" }] }],
      }),
    },
  });

  const result = await run(admin, output, { force: true });

  // Everything the catalog listed, including keys the new tree also wants —
  // that is what makes it a clean slate rather than a diff.
  assert.deepEqual(removed.sort(), [
    "a-book/a-book.epub",
    "a-book/metadata.json",
    "catalog.json",
  ]);
  assert.equal(result.exact, false);
  assert.equal(result.uploaded, 4);
});

test("a failed upload is counted and named, and the rest still publish", async () => {
  const output = await tree(LIBRARY);
  const { admin } = fakeAdmin();
  const log = [];

  const put = admin.put;
  admin.put = async (key, file, contentType) => {
    if (key === "a-book/cover.webp") throw new Error("cover upload exploded");
    return put(key, file, contentType);
  };

  const result = await syncLibrary(admin, output, {
    log: (line) => log.push(line),
  });

  assert.equal(result.failed, 1);
  assert.equal(result.uploaded, 3);
  assert.ok(log.some((line) => /fail\s+a-book\/cover\.webp/.test(line)));
  assert.ok(log.some((line) => /cover upload exploded/.test(line)));
});

test("a failed delete is a warning, not the end of the run", async () => {
  const output = await tree(LIBRARY);
  const { admin } = fakeAdmin({
    canList: true,
    objects: { "orphan/thing.epub": "x" },
  });
  admin.remove = async () => {
    throw new Error("delete exploded");
  };
  const log = [];

  const result = await syncLibrary(admin, output, {
    log: (line) => log.push(line),
  });

  // The upload is the point; a stale object left behind is not worth failing.
  assert.equal(result.uploaded, 4);
  assert.equal(result.failed, 0);
  assert.ok(log.some((line) => /warn\s+could not delete/.test(line)));
});
