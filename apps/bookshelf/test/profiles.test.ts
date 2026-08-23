import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PROFILE_ID,
  DEFAULT_PROFILE_NAME,
  PROFILES_FILE,
  type Profile,
  type Profiles,
  progressFile,
} from "@bookshelf/core";
import { LibraryUnavailableError } from "../src/services/errors.ts";
import {
  cleanName,
  ProfileService,
  ReadOnlyLibraryError,
} from "../src/services/profiles.ts";
import { memoryStorage } from "./lib/storage.ts";

function profilesFile(profiles: unknown[]) {
  return { [PROFILES_FILE]: JSON.stringify({ version: 1, profiles }) };
}

function profile(id: string, name = id): Profile {
  return { id, name, createdAt: new Date(0).toISOString() };
}

test("a library nobody has configured has one profile and no file", async () => {
  // Nothing is written until there is something worth writing, so a fresh
  // install costs no round trip to create state it may never need — and a
  // read-only library is perfectly usable.
  const library = memoryStorage({});
  const profiles = new ProfileService(library.storage);

  const list = await profiles.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, DEFAULT_PROFILE_ID);
  assert.equal(list[0].name, DEFAULT_PROFILE_NAME);
  assert.equal(library.has(PROFILES_FILE), false);
  assert.deepEqual(library.writes, []);
});

test("creating a second profile records the first one too", async () => {
  // The first profile was implicit and unwritten. A library with two of them
  // has to record both, or the default would vanish the moment it was joined.
  const library = memoryStorage({});
  const profiles = new ProfileService(library.storage);

  await profiles.create("Murat");

  assert.deepEqual(
    library.json<Profiles>(PROFILES_FILE).profiles.map((p) => p.id),
    [DEFAULT_PROFILE_ID, "murat"],
  );
});

test("an id is derived from the name, and never collides", async () => {
  const library = memoryStorage({});
  const profiles = new ProfileService(library.storage);

  assert.equal((await profiles.create("Murat Erkin")).id, "murat-erkin");
  assert.equal((await profiles.create("Murat Erkin")).id, "murat-erkin-2");
  assert.equal((await profiles.create("murat erkin")).id, "murat-erkin-3");

  // A name with nothing usable in it still needs an id that is a valid file
  // name, because that is what it becomes.
  assert.equal((await profiles.create("日本語")).id, "reader");
  assert.equal((await profiles.create("!!!")).id, "reader-2");
});

test("a nameless profile is still a profile", async () => {
  const library = memoryStorage({});
  const profiles = new ProfileService(library.storage);

  const created = await profiles.create("   ");
  assert.equal(created.name, "Reader");
});

test("a library holds a household, not a directory", async () => {
  const library = memoryStorage(
    profilesFile(Array.from({ length: 16 }, (_, i) => profile(`reader-${i}`))),
  );
  const profiles = new ProfileService(library.storage);

  // The cap is here because the file is read on every render and rewritten
  // whole, so the failure it prevents is a slow shelf rather than a full disk.
  await assert.rejects(profiles.create("One More"), /at most 16 profiles/);
});

test("the profile a request belongs to, and what happens when it is gone", async () => {
  const library = memoryStorage(
    profilesFile([profile("murat", "Murat"), profile("guest", "Guest")]),
  );
  const profiles = new ProfileService(library.storage);

  assert.equal((await profiles.resolve("guest")).name, "Guest");
  // A cookie can outlive the profile it pointed at, and a deleted profile
  // should not lock anyone out of their own shelf.
  assert.equal((await profiles.resolve("deleted-last-week")).id, "murat");
  assert.equal((await profiles.resolve(undefined)).id, "murat");
});

test("renaming needs a name", async () => {
  const library = memoryStorage(profilesFile([profile("murat", "Murat")]));
  const profiles = new ProfileService(library.storage);

  await profiles.rename("murat", "  Murat   Erkin  ");
  assert.equal(
    library.json<Profiles>(PROFILES_FILE).profiles[0].name,
    "Murat Erkin",
  );

  await assert.rejects(profiles.rename("murat", "   "), /needs a name/);
  // An id nobody has is not an error, because the form could have raced a
  // deletion.
  await profiles.rename("nobody", "Whoever");
  assert.equal(library.json<Profiles>(PROFILES_FILE).profiles.length, 1);
});

test("a library keeps at least one profile", async () => {
  const library = memoryStorage(profilesFile([profile("only")]));
  const profiles = new ProfileService(library.storage);

  await assert.rejects(profiles.remove("only"), /at least one profile/);
});

test("removing a profile takes what it had read with it", async () => {
  const library = memoryStorage({
    ...profilesFile([profile("murat"), profile("guest")]),
    [progressFile("guest")]: '{"version":1,"books":{"a-book":{}}}',
  });
  const profiles = new ProfileService(library.storage);

  await profiles.remove("guest");

  assert.deepEqual(
    library.json<Profiles>(PROFILES_FILE).profiles.map((p) => p.id),
    ["murat"],
  );
  // Otherwise a new profile allocated the same id would inherit a stranger's
  // reading positions.
  assert.equal(library.has(progressFile("guest")), false);
  // And the other profile's are untouched.
  assert.equal(library.has(progressFile("murat")), false);
});

test("removing a profile nobody has changes nothing", async () => {
  const library = memoryStorage(profilesFile([profile("a"), profile("b")]));
  const profiles = new ProfileService(library.storage);

  await profiles.remove("c");
  assert.equal((await profiles.list()).length, 2);
});

test("a corrupt profile file does not take the shelf down with it", async () => {
  const library = memoryStorage({ [PROFILES_FILE]: "{ not json" });
  const profiles = new ProfileService(library.storage);

  // The library still reads, and the implicit default takes over.
  const list = await profiles.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, DEFAULT_PROFILE_ID);
});

test("entries that could not be file names are dropped, not trusted", async () => {
  const library = memoryStorage(
    profilesFile([
      profile("valid", "Valid"),
      { id: "../escape", name: "Escaping" },
      { id: "Upper", name: "Wrong case" },
      { id: "no-name" },
      { name: "no id" },
      null,
    ]),
  );
  const profiles = new ProfileService(library.storage);

  // Ids become file names under the state prefix, so an id that is not one is
  // not a profile.
  assert.deepEqual(
    (await profiles.list()).map((p) => p.id),
    ["valid"],
  );
});

test("a library that cannot be written to refuses to be changed", async () => {
  // The same degradation as BOOKSHELF_READ_ONLY, because to the app it is the
  // same situation: reading positions go back to living in the browser.
  const library = memoryStorage(profilesFile([profile("a"), profile("b")]), {
    writable: false,
  });
  const profiles = new ProfileService(library.storage);

  assert.equal(profiles.writable, false);

  await assert.rejects(profiles.create("Anyone"), ReadOnlyLibraryError);
  await assert.rejects(profiles.rename("a", "Renamed"), ReadOnlyLibraryError);
  await assert.rejects(profiles.remove("b"), ReadOnlyLibraryError);

  // Switching between the profiles that exist still works — that is a cookie,
  // not a change.
  assert.equal((await profiles.resolve("b")).id, "b");
  assert.equal((await profiles.list()).length, 2);
  assert.deepEqual(library.writes, []);
});

test("a writable library says so", async () => {
  const library = memoryStorage({});
  assert.equal(new ProfileService(library.storage).writable, true);
});

test("a name is trimmed, collapsed and bounded", () => {
  assert.equal(cleanName("  Murat  Erkin  "), "Murat Erkin");
  assert.equal(cleanName("Murat\n\tErkin"), "Murat Erkin");
  assert.equal(cleanName("a".repeat(60)).length, 40);
  assert.equal(cleanName(""), "");
  assert.equal(cleanName("   "), "");
  // Anything that is not a string is not a name.
  assert.equal(cleanName(undefined), "");
  assert.equal(cleanName(null), "");
  assert.equal(cleanName(42), "");
  assert.equal(cleanName({ name: "sneaky" }), "");
});

test("an unreachable library refuses to guess who is reading", async () => {
  // Deliberately not the implicit default. The answer decides which file a
  // reading position is written to, so guessing would put one reader's place in
  // a book into a file belonging to nobody — and displace what was there.
  const library = memoryStorage(profilesFile([profile("murat", "Murat")]), {
    failing: true,
  });
  const profiles = new ProfileService(library.storage);

  await assert.rejects(profiles.list(), LibraryUnavailableError);
  await assert.rejects(profiles.resolve("murat"), LibraryUnavailableError);
});

test("a change that could not be written says so", async () => {
  const library = memoryStorage(profilesFile([profile("a"), profile("b")]));
  const profiles = new ProfileService(library.storage);
  library.fail();

  // Not a ReadOnlyLibraryError: this library does have a write path, it just
  // could not be reached. The distinction is what the profiles page needs to
  // say something true about it.
  await assert.rejects(profiles.create("Someone"), LibraryUnavailableError);
  await assert.rejects(
    profiles.rename("a", "Renamed"),
    LibraryUnavailableError,
  );
  await assert.rejects(profiles.remove("b"), LibraryUnavailableError);
});

test("a profile is removed even if clearing up after it fails", async () => {
  const library = memoryStorage({
    ...profilesFile([profile("murat"), profile("guest")]),
    [progressFile("guest")]: '{"version":1,"books":{}}',
  });
  const profiles = new ProfileService(library.storage);

  // The list is written first and the positions cleaned up after, so a failure
  // in the cleanup must not report that the removal did not happen.
  let calls = 0;
  const remove = library.storage.remove;
  library.storage.remove = async () => {
    calls++;
    throw new Error("delete exploded");
  };

  await profiles.remove("guest");
  library.storage.remove = remove;

  assert.equal(calls, 1);
  assert.deepEqual(
    (await profiles.list()).map((p) => p.id),
    ["murat"],
  );
});
