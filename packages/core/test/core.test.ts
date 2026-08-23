import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bookKey,
  bytesSource,
  capabilitiesOf,
  contentTypeFor,
  defaultProfile,
  isProfileId,
  isStateKey,
  PROFILES_FILE,
  parseJsonc,
  progressFile,
  rangedSource,
  readOnlyStorage,
  STATE_PREFIX,
  stripJsonComments,
  writableStorage,
} from "@bookshelf/core";

test("strips comments from JSON without touching what is inside strings", () => {
  const config = `{
  // where books come from
  "input": "books",
  /* and where the tree
     is built */
  "output": "library",
  "note": "a // b and /* c */ stay put",
  "url": "https://example.com/path",
  "escaped": "a quote \\" then // not a comment"
}`;

  assert.deepEqual(parseJsonc(config), {
    input: "books",
    output: "library",
    note: "a // b and /* c */ stay put",
    // The one that matters: a URL's double slash is inside a string, and a
    // stripper that scanned for `//` would truncate the value.
    url: "https://example.com/path",
    escaped: 'a quote " then // not a comment',
  });
});

test("a comment at the end of a file with no newline after it", () => {
  assert.deepEqual(parseJsonc('{"a": 1}\n// trailing'), { a: 1 });
  assert.deepEqual(parseJsonc('{"a": 1} /* trailing'), { a: 1 });
});

test("plain JSON passes through unchanged", () => {
  const plain = '{"a":[1,2,{"b":"c"}]}';
  assert.equal(stripJsonComments(plain), plain);
});

test("a line comment keeps its newline, so the JSON still parses", () => {
  // Without the newline, `1 "b"` would run together into a syntax error.
  assert.deepEqual(parseJsonc('{"a": 1, // note\n"b": 2}'), { a: 1, b: 2 });
});

test("state lives under one reserved prefix", () => {
  // Book folders are named after slugified titles, which cannot begin with a
  // dot — so the namespace is reserved by construction rather than by hoping
  // nobody publishes a book called "bookshelf".
  assert.ok(PROFILES_FILE.startsWith(STATE_PREFIX));
  assert.ok(progressFile("reader").startsWith(STATE_PREFIX));

  assert.equal(isStateKey(PROFILES_FILE), true);
  assert.equal(isStateKey(progressFile("someone")), true);

  // Everything the sync tool publishes is not state, and must not be mistaken
  // for it — a provider excludes state from enumeration, and over-matching here
  // would hide real books from `--force`.
  assert.equal(isStateKey("catalog.json"), false);
  assert.equal(isStateKey("a-book/metadata.json"), false);
  assert.equal(isStateKey("a-book/a-book.epub"), false);
  assert.equal(isStateKey("bookshelf/a.epub"), false);
});

test("a profile id is constrained because it becomes a file name", () => {
  assert.equal(isProfileId("default"), true);
  assert.equal(isProfileId("murat-erkin"), true);
  assert.equal(isProfileId("a1"), true);
  assert.equal(isProfileId("9lives"), true);

  // A leading dash would make an id that reads as a flag; the rest would either
  // escape the state directory or not survive being a file name.
  assert.equal(isProfileId("-leading"), false);
  assert.equal(isProfileId(""), false);
  assert.equal(isProfileId("Upper"), false);
  assert.equal(isProfileId("has space"), false);
  assert.equal(isProfileId("has_underscore"), false);
  assert.equal(isProfileId("../escape"), false);
  assert.equal(isProfileId("a/b"), false);
  assert.equal(isProfileId("a".repeat(65)), false);
  assert.equal(isProfileId("a".repeat(64)), true);
});

test("the implicit default profile is dated to the epoch", () => {
  const profile = defaultProfile();
  assert.equal(isProfileId(profile.id), true);
  // So that a real profile created later always sorts as newer.
  assert.equal(profile.createdAt, new Date(0).toISOString());
});

test("an object's key is its folder and its file", () => {
  assert.equal(bookKey("a-book", "a-book.epub"), "a-book/a-book.epub");
  assert.equal(bookKey("a-book", "cover.webp"), "a-book/cover.webp");
});

test("content types come from the name, so both sides agree", () => {
  // The filesystem has nowhere to store one, so it derives it; R2 records what
  // the sync tool sent. One table means they land on the same answer.
  assert.equal(contentTypeFor("a-book.epub"), "application/epub+zip");
  assert.equal(contentTypeFor("a-book.pdf"), "application/pdf");
  assert.equal(contentTypeFor("cover.webp"), "image/webp");
  assert.equal(contentTypeFor("catalog.json"), "application/json");
  assert.equal(contentTypeFor("a-book/nested/cover.jpg"), "image/jpeg");
  assert.equal(contentTypeFor("mystery.xyz"), "application/octet-stream");
  assert.equal(contentTypeFor("no-extension"), "application/octet-stream");
});

test("writable storage is decided by asking, not by trying and catching", () => {
  const reads = {
    head: async () => null,
    read: async () => null,
    readBytes: async () => null,
    readRange: async () => null,
  };

  assert.equal(writableStorage(reads), null);
  // Half a write path is not a write path: profiles need both to be usable.
  assert.equal(writableStorage({ ...reads, write: async () => {} }), null);
  assert.equal(writableStorage({ ...reads, remove: async () => {} }), null);

  const writable = { ...reads, write: async () => {}, remove: async () => {} };
  assert.equal(writableStorage(writable), writable);
});

test("read-only storage carries no write path at all", () => {
  const calls = [];
  const writable = {
    head: async () => null,
    read: async (key, options) => {
      calls.push({ key, options });
      return null;
    },
    readBytes: async () => null,
    readRange: async () => null,
    write: async () => calls.push("write"),
    remove: async () => calls.push("remove"),
  };

  const readOnly = readOnlyStorage(writable);

  // Absent rather than throwing, because `writableStorage` decides by asking
  // whether the methods are there — so a deployment that refuses edits and a
  // provider that cannot make them are the same situation downstream.
  assert.equal(readOnly.write, undefined);
  assert.equal(readOnly.remove, undefined);
  assert.equal(writableStorage(readOnly), null);
});

test("read-only storage passes read options through", async () => {
  // Including ones added later: a wrapper that forgot to forward `range` would
  // silently serve whole objects for every ranged request against a read-only
  // library, and the route would call that a complete answer.
  const seen = [];
  const readOnly = readOnlyStorage({
    head: async () => null,
    read: async (key, options) => {
      seen.push({ key, options });
      return null;
    },
    readBytes: async () => null,
    readRange: async (key, offset, length) => {
      seen.push({ key, offset, length });
      return null;
    },
  });

  await readOnly.read("a.epub", {
    ifNoneMatch: '"abc"',
    range: { offset: 10, length: 20 },
  });
  await readOnly.readRange("a.epub", 5, 15);

  assert.deepEqual(seen, [
    {
      key: "a.epub",
      options: { ifNoneMatch: '"abc"', range: { offset: 10, length: 20 } },
    },
    { key: "a.epub", offset: 5, length: 15 },
  ]);
});

test("an admin's capabilities are asked of the instance", () => {
  const base = {
    name: "somewhere",
    read: async () => null,
    put: async () => {},
    remove: async () => {},
  };

  // What the wrangler-backed R2 admin looks like: it cannot enumerate.
  assert.deepEqual(capabilitiesOf(base), {
    create: false,
    list: false,
    removeAll: false,
  });

  assert.deepEqual(
    capabilitiesOf({
      ...base,
      create: async () => true,
      list: async () => [],
      removeAll: async () => 0,
    }),
    { create: true, list: true, removeAll: true },
  );
});

test("a source over bytes clamps rather than refusing an over-read", async () => {
  // Which is what the ZIP reader relies on: it speculates past the end of an
  // entry on purpose, and object storage answers the same way.
  const source = bytesSource(new TextEncoder().encode("0123456789"));

  assert.equal(await source.size(), 10);
  assert.deepEqual(await source.read(0, 4), new TextEncoder().encode("0123"));
  assert.deepEqual(await source.read(8, 100), new TextEncoder().encode("89"));

  // Nothing readable at all is null, not an empty array.
  assert.equal(await source.read(10, 5), null);
  assert.equal(await source.read(-1, 5), null);
  assert.equal(await source.read(0, 0), null);
});

test("a ranged source can be told its size or asked for it", async () => {
  let asked = 0;
  const lazy = rangedSource(
    async () => {
      asked++;
      return 42;
    },
    async () => null,
  );

  // Called only when a reader needs it, so reading an entry at a known offset
  // costs no extra round trip.
  assert.equal(asked, 0);
  assert.equal(await lazy.size(), 42);
  assert.equal(asked, 1);

  const known = rangedSource(42, async () => null);
  assert.equal(await known.size(), 42);
});
