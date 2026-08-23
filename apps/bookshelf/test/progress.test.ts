import assert from "node:assert/strict";
import { test } from "node:test";
import { progressFile, STATE_VERSION } from "@bookshelf/core";
import { ProgressService } from "../src/services/progress.ts";
import { memoryStorage, must } from "./lib/storage.ts";

const POSITION = { cfi: "epubcfi(/6/14[ch3]!/4/2/2)", href: "ch3.xhtml" };

test("a position saved is a position read back", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  assert.equal(await progress.save("murat", "a-book", POSITION), true);

  const saved = must(await progress.get("murat", "a-book"), "a position");
  assert.equal(saved.cfi, POSITION.cfi);
  assert.equal(saved.href, POSITION.href);
  // What decides which device wins when two have been reading.
  assert.ok(Date.parse(saved.updatedAt) > 0);

  // One object per profile, so the shelf can show every position it knows
  // about in a single request.
  assert.equal(
    library.json<{ version: number }>(progressFile("murat")).version,
    STATE_VERSION,
  );
});

test("a profile that has read nothing has no positions and no file", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  assert.deepEqual(await progress.all("murat"), {});
  assert.equal(await progress.get("murat", "a-book"), null);
  assert.equal(library.has(progressFile("murat")), false);
});

test("positions are kept per profile", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "a-book", { cfi: "mine" });
  await progress.save("guest", "a-book", { cfi: "theirs" });

  // Housemates' bookmarks stay apart, which is what profiles are for.
  assert.equal(must(await progress.get("murat", "a-book")).cfi, "mine");
  assert.equal(must(await progress.get("guest", "a-book")).cfi, "theirs");
});

test("every book a profile has opened comes back at once", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "one", { cfi: "a" });
  await progress.save("murat", "two", { cfi: "b" });

  // The shelf reads this once and shows Continue on the books it names.
  assert.deepEqual(Object.keys(await progress.all("murat")).sort(), [
    "one",
    "two",
  ]);
});

test("a position records only what it was given", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "a-book", { cfi: "just-the-cfi" });
  const cfiOnly = must(await progress.get("murat", "a-book"), "a position");
  assert.equal(cfiOnly.cfi, "just-the-cfi");
  assert.ok(!("href" in cfiOnly));

  await progress.save("murat", "b-book", { href: "just-the-href" });
  const hrefOnly = must(await progress.get("murat", "b-book"), "a position");
  assert.equal(hrefOnly.href, "just-the-href");
  assert.ok(!("cfi" in hrefOnly));
});

test("saving a position again replaces it", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "a-book", { cfi: "chapter one" });
  const first = must(await progress.get("murat", "a-book"), "a position");

  await progress.save("murat", "a-book", { cfi: "chapter nine" });
  const second = must(await progress.get("murat", "a-book"), "a position");

  assert.equal(second.cfi, "chapter nine");
  // Two devices reading as one profile is last-write-wins, and the timestamp is
  // what makes that decidable.
  assert.ok(second.updatedAt >= first.updatedAt);
});

test("forgetting one book leaves the others alone", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "one", { cfi: "a" });
  await progress.save("murat", "two", { cfi: "b" });

  assert.equal(await progress.clear("murat", "one"), true);
  assert.deepEqual(Object.keys(await progress.all("murat")), ["two"]);
});

test("forgetting a book never read is not a failure", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "one", { cfi: "a" });
  assert.equal(await progress.clear("murat", "never-opened"), true);
  // And it does not rewrite the file to say the same thing.
  assert.deepEqual(Object.keys(await progress.all("murat")), ["one"]);
});

test("forgetting everything removes the file rather than emptying it", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "one", { cfi: "a" });
  assert.equal(await progress.clear("murat"), true);

  assert.equal(library.has(progressFile("murat")), false);
  assert.deepEqual(await progress.all("murat"), {});
});

test("a corrupt progress file reads as no positions", async () => {
  const library = memoryStorage({
    [progressFile("murat")]: "{ half a file",
  });
  const progress = new ProgressService(library.storage);

  // Reading starts from the beginning rather than the shelf failing to render.
  assert.deepEqual(await progress.all("murat"), {});
  assert.equal(await progress.get("murat", "a-book"), null);
});

test("a library that cannot be written to says so instead of throwing", async () => {
  // The reader asks before it offers to sync, and a position that cannot be
  // stored is kept in the browser instead — so this has to be answerable, not
  // an error at the moment someone turns a page.
  const library = memoryStorage(
    { [progressFile("murat")]: '{"version":1,"books":{"a-book":{"cfi":"x"}}}' },
    { writable: false },
  );
  const progress = new ProgressService(library.storage);

  assert.equal(progress.writable, false);
  assert.equal(await progress.save("murat", "a-book", POSITION), false);
  assert.equal(await progress.clear("murat", "a-book"), false);
  assert.equal(await progress.clear("murat"), false);

  // Reading what is already there still works.
  assert.equal(must(await progress.get("murat", "a-book")).cfi, "x");
  assert.deepEqual(library.writes, []);
});

test("a writable library says so", async () => {
  const library = memoryStorage({});
  assert.equal(new ProgressService(library.storage).writable, true);
});

test("positions that cannot be read cost nothing", async () => {
  const library = memoryStorage(
    { [progressFile("murat")]: '{"version":1,"books":{"a-book":{"cfi":"x"}}}' },
    { failing: true },
  );
  const progress = new ProgressService(library.storage);

  // The shelf shows "Read" rather than "Continue", and the reader reconciles
  // against the copy the browser kept — so none is a safe answer here.
  assert.deepEqual(await progress.all("murat"), {});
  assert.equal(await progress.get("murat", "a-book"), null);
});

test("a position is not saved over a file that could not be read", async () => {
  // The one place degrading would lose data. This file holds every book the
  // profile has open and is rewritten whole, so saving after a failed read
  // would replace nine positions with one.
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "one", { cfi: "first" });
  await progress.save("murat", "two", { cfi: "second" });

  const before = library.json<{ books: Record<string, unknown> }>(
    progressFile("murat"),
  );
  assert.deepEqual(Object.keys(before.books).sort(), ["one", "two"]);

  // Only the read fails. The write still works, which is what makes this
  // dangerous rather than merely unlucky: a service that treated the failed
  // read as "no positions yet" would write a file containing only the third.
  library.fail("readBytes");
  assert.equal(await progress.save("murat", "three", { cfi: "third" }), false);
  library.heal();

  // Untouched: still both books, and no third.
  assert.deepEqual(library.json(progressFile("murat")), before);
});

test("clearing one book is refused rather than guessed at", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  await progress.save("murat", "one", { cfi: "first" });
  await progress.save("murat", "two", { cfi: "second" });
  const before = library.json<{ books: Record<string, unknown> }>(
    progressFile("murat"),
  );

  // Again the read alone, so a rewrite really could have landed.
  library.fail("readBytes");
  assert.equal(await progress.clear("murat", "one"), false);
  library.heal();

  library.fail("remove");
  assert.equal(await progress.clear("murat"), false);
  library.heal();

  assert.deepEqual(library.json(progressFile("murat")), before);
});

test("a write that does not land is reported, not assumed", async () => {
  const library = memoryStorage({});
  const progress = new ProgressService(library.storage);

  // Readable, but the write fails: the position exists nowhere but the browser,
  // and `false` is what tells the reader to keep it there.
  const write = library.storage.write;
  library.storage.write = async () => {
    throw new Error("write exploded");
  };

  assert.equal(await progress.save("murat", "one", { cfi: "first" }), false);

  library.storage.write = write;
  assert.equal(library.has(progressFile("murat")), false);
});
