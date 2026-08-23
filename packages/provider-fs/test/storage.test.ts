import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAdmin, createStorage } from "@bookshelf/provider-fs/node";

/** A library holding one object, and the storage that reads it. */
async function library(contents = "0123456789") {
  const directory = await mkdtemp(path.join(tmpdir(), "bookshelf-fs-"));
  await writeFile(path.join(directory, "book.epub"), contents);
  return {
    storage: createStorage({ directory, projectRoot: directory }),
    directory,
  };
}

async function text(body) {
  return body ? new Response(body).text() : null;
}

test("serves a whole object when no range is asked for", async () => {
  const { storage } = await library();
  const found = await storage.read("book.epub");

  assert.equal(await text(found.body), "0123456789");
  assert.equal(found.object.size, 10);
  // Absent, which is what tells the caller to answer 200 rather than 206.
  assert.equal(found.range, undefined);
});

test("serves exactly the bytes a range asks for", async () => {
  const { storage } = await library();

  const middle = await storage.read("book.epub", {
    range: { offset: 3, length: 4 },
  });
  assert.equal(await text(middle.body), "3456");
  assert.deepEqual(middle.range, { offset: 3, length: 4 });
  // The whole object's size, because that is what a `Content-Range` names.
  assert.equal(middle.object.size, 10);

  // The first byte, and the last.
  const first = await storage.read("book.epub", {
    range: { offset: 0, length: 1 },
  });
  assert.equal(await text(first.body), "0");

  const last = await storage.read("book.epub", {
    range: { offset: 9, length: 1 },
  });
  assert.equal(await text(last.body), "9");
});

test("clamps a range that runs past the end", async () => {
  const { storage } = await library();

  const over = await storage.read("book.epub", {
    range: { offset: 8, length: 100 },
  });
  assert.equal(await text(over.body), "89");
  // Reports what it served, not what was asked for.
  assert.deepEqual(over.range, { offset: 8, length: 2 });
});

test("refuses a range that starts past the end", async () => {
  const { storage } = await library();

  const beyond = await storage.read("book.epub", {
    range: { offset: 10, length: 5 },
  });
  // No body and no range, so the caller answers 416 rather than sending an
  // empty 206.
  assert.equal(beyond.body, null);
  assert.equal(beyond.range, undefined);
  assert.equal(beyond.object.size, 10);
});

test("an empty object can answer no range at all", async () => {
  const { storage } = await library("");

  const found = await storage.read("book.epub", {
    range: { offset: 0, length: 1 },
  });
  assert.equal(found.body, null);
  assert.equal(found.object.size, 0);
});

test("a matching validator skips the body, range or no range", async () => {
  const { storage } = await library();
  const { object } = await storage.read("book.epub");

  const whole = await storage.read("book.epub", { ifNoneMatch: object.etag });
  assert.equal(whole.body, null);

  // A conditional range request that matches is a 304, not a 206: the caller
  // already holds this version.
  const ranged = await storage.read("book.epub", {
    ifNoneMatch: object.etag,
    range: { offset: 2, length: 3 },
  });
  assert.equal(ranged.body, null);
  assert.equal(ranged.range, undefined);

  // A validator for some other version is not a match.
  const stale = await storage.read("book.epub", { ifNoneMatch: '"nope"' });
  assert.equal(await text(stale.body), "0123456789");
});

test("a missing object is missing, whatever was asked of it", async () => {
  const { storage } = await library();

  assert.equal(await storage.read("absent.epub"), null);
  assert.equal(
    await storage.read("absent.epub", { range: { offset: 0, length: 1 } }),
    null,
  );
  // A key that would escape the library resolves to nothing, ranged or not.
  assert.equal(
    await storage.read("../../etc/passwd", { range: { offset: 0, length: 1 } }),
    null,
  );
});

test("consecutive ranges reassemble into the original", async () => {
  const contents = "abcdefghijklmnopqrstuvwxyz".repeat(400);
  const { storage } = await library(contents);

  // What a PDF viewer does: walk the object a chunk at a time.
  const chunk = 1000;
  let assembled = "";
  for (let offset = 0; offset < contents.length; offset += chunk) {
    const part = await storage.read("book.epub", {
      range: { offset, length: chunk },
    });
    assembled += await text(part.body);
  }

  assert.equal(assembled, contents);
  assert.equal(assembled.length, contents.length);
});

/** A library with books in it and app-written state alongside them. */
async function published() {
  const directory = await mkdtemp(path.join(tmpdir(), "bookshelf-fs-"));
  const write = async (key, contents) => {
    const target = path.join(directory, key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  };

  await write("catalog.json", "{}");
  await write("a-book/metadata.json", "{}");
  await write("a-book/a-book.epub", "epub");
  await write(".bookshelf/profiles.json", '{"profiles":[]}');
  await write(".bookshelf/progress/reader.json", '{"books":{}}');

  return {
    directory,
    admin: createAdmin({ directory, projectRoot: directory }),
  };
}

test("enumeration reports the library and not the app's own state", async () => {
  const { admin } = await published();

  // `list` is what the sync tool may remove. Anything that reports state keys
  // will have `--force` delete everyone's bookmarks.
  assert.deepEqual(await admin.list(), [
    "a-book/a-book.epub",
    "a-book/metadata.json",
    "catalog.json",
  ]);
});

test("emptying the destination leaves profiles and positions alone", async () => {
  const { directory, admin } = await published();

  const removed = await admin.removeAll();

  // It reports what it removed of the library.
  assert.equal(removed, 3);
  assert.deepEqual((await readdir(directory)).sort(), [".bookshelf"]);
  // And the state is untouched, not merely present.
  assert.equal(
    await readFile(
      path.join(directory, ".bookshelf/progress/reader.json"),
      "utf8",
    ),
    '{"books":{}}',
  );
});

test("a destination that does not exist yet holds nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bookshelf-fs-"));
  const directory = path.join(root, "not-created-yet");
  const admin = createAdmin({ directory, projectRoot: root });

  // Not an error: the first publish creates it.
  assert.deepEqual(await admin.list(), []);
  assert.equal(await admin.create(), true);
  // Idempotent, so a second `--create` is not a failure.
  assert.equal(await admin.create(), false);
});

test("deleting the last book in a folder takes the folder with it", async () => {
  const { directory, admin } = await published();

  await admin.remove("a-book/metadata.json");
  await admin.remove("a-book/a-book.epub");

  // Otherwise a removed book would leave its folder behind for good.
  assert.deepEqual((await readdir(directory)).sort(), [
    ".bookshelf",
    "catalog.json",
  ]);
});

test("a key that escapes the library is refused, not tidied up", async () => {
  const { admin } = await published();

  // Keys arrive from URLs and from a built tree, so resolving one outside the
  // library must never land on a real path. Writing says so outright, because a
  // publish that silently put a file somewhere else would be worse than a
  // failed one.
  await assert.rejects(admin.put("../escaped.epub", "/dev/null", "text/plain"));
  await assert.rejects(admin.remove("../../something"));

  // Reading refuses too. It used to answer "nothing there", because the catch
  // that turns a missing file into null swallowed this as well — the same catch
  // that was turning an unreadable file into an absent one. Now only a failure
  // that really means "no such object" is quiet, and a key that escapes the
  // library is not one.
  await assert.rejects(admin.read("../../etc/passwd"), /escapes the library/);
  await assert.rejects(admin.read("/etc/passwd"), /escapes the library/);
});

test("a file that cannot be read is not reported as absent", async () => {
  // The distinction the app's whole answer to an outage rests on. A provider
  // that swallows every error has the shelf say "no catalog published yet" when
  // the real problem is a permission or a failing disk.
  const { directory, storage } = await library();
  const file = path.join(directory, "book.epub");

  await chmod(file, 0o000);
  try {
    // What the services read a catalog, a profile list and a position with.
    await assert.rejects(storage.readBytes("book.epub"), /EACCES/);

    // Metadata still answers, which is not a contradiction: `stat` needs no
    // permission on the file itself, only on the directory holding it. So the
    // object's size and validator are knowable while its contents are not.
    assert.equal((await storage.head("book.epub")).size, 10);
  } finally {
    await chmod(file, 0o644);
  }

  // And a file that is genuinely not there is still quietly absent.
  assert.equal(await storage.readBytes("nowhere.epub"), null);
  assert.equal(await storage.head("nowhere.epub"), null);
});
