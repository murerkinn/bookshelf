import {
  defaultProfile,
  isProfileId,
  PROFILES_FILE,
  type Profile,
  type Profiles,
  progressFile,
  STATE_VERSION,
  type Storage,
  writableStorage,
} from "@bookshelf/core";
import {
  LibraryUnavailableError,
  optional,
  reading,
  writing,
} from "@/services/errors";

export type { Profile } from "@bookshelf/core";

/**
 * Enough for a household, few enough that the list stays a list. The cap is
 * here because the profile file is read on every render and rewritten whole.
 */
const MAX_PROFILES = 16;
const MAX_NAME_LENGTH = 40;

/**
 * How many deleted ids the profile file remembers. The list only has to
 * outlast a page turn that was already on its way when its profile was
 * deleted; anything older that left a file behind is caught by looking for the
 * file. Bounded because this file is read on every render, and deleting is
 * something anyone who can reach the shelf can do as often as they like.
 */
const MAX_RETIRED = 64;

/** Thrown when a change is asked of a library the app cannot write to. */
export class ReadOnlyLibraryError extends Error {
  constructor() {
    super(
      "This library cannot be written to, so profiles cannot be changed. " +
        "Reading positions are kept in the browser instead.",
    );
    this.name = "ReadOnlyLibraryError";
  }
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2));
}

/** A profile id derived from its name: readable in storage, safe as a key. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** The ids a profile with this name could have, most readable first. */
function* candidateIds(name: string): Generator<string> {
  const base = slug(name);
  const candidate = isProfileId(base) ? base : "reader";
  yield candidate;

  for (let n = 2; n < 1000; n++) yield `${candidate}-${n}`;
}

/** What the profile file holds, with the implicit default not yet filled in. */
type Stored = { profiles: Profile[]; retired: string[] };

export function cleanName(value: unknown): string {
  const name =
    typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return name.slice(0, MAX_NAME_LENGTH);
}

/**
 * Who is reading.
 *
 * A library nobody has configured has no profile file at all — {@link list}
 * answers with the implicit default instead. Nothing is written until there is
 * something worth writing, so a fresh install costs no round trip to create
 * state it may never need, and a read-only library still works.
 */
export class ProfileService {
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /** Whether profiles can be changed at all, which the UI asks before offering. */
  get writable(): boolean {
    return writableStorage(this.storage) !== null;
  }

  async list(): Promise<Profile[]> {
    return (await this.state()).profiles;
  }

  /**
   * The profile a request belongs to: the one its cookie names, or the first,
   * which is the only one most libraries ever have.
   *
   * An id that names no profile falls back rather than failing — a cookie can
   * outlive the profile it pointed at, and a deleted profile should not lock
   * anyone out of their own shelf.
   */
  async resolve(id: string | undefined): Promise<Profile> {
    const profiles = await this.list();
    return profiles.find((profile) => profile.id === id) ?? profiles[0];
  }

  async create(name: string): Promise<Profile> {
    const { profiles, retired } = await this.state();
    if (profiles.length >= MAX_PROFILES) {
      throw new Error(`A library holds at most ${MAX_PROFILES} profiles.`);
    }

    const cleaned = cleanName(name) || "Reader";
    const profile: Profile = {
      id: await this.unusedId(
        cleaned,
        new Set([...profiles.map((p) => p.id), ...retired]),
      ),
      name: cleaned,
      createdAt: new Date().toISOString(),
    };

    // `profiles` may be the implicit default, which is persisted here for the
    // first time — a library with two profiles has to record both.
    await this.save([...profiles, profile], retired);
    return profile;
  }

  async rename(id: string, name: string): Promise<void> {
    const cleaned = cleanName(name);
    if (!cleaned) throw new Error("A profile needs a name.");

    const { profiles, retired } = await this.state();
    if (!profiles.some((profile) => profile.id === id)) return;

    await this.save(
      profiles.map((profile) =>
        profile.id === id ? { ...profile, name: cleaned } : profile,
      ),
      retired,
    );
  }

  /** Removes a profile and everything it had read. Never the last one. */
  async remove(id: string): Promise<void> {
    const { profiles, retired } = await this.state();
    if (profiles.length <= 1) {
      throw new Error("A library keeps at least one profile.");
    }
    if (!profiles.some((profile) => profile.id === id)) return;

    await this.save(
      profiles.filter((profile) => profile.id !== id),
      [...retired, id].slice(-MAX_RETIRED),
    );

    // Best effort, and deliberately after the list was written: the profile is
    // gone either way, and failing here would report that the removal did not
    // happen when it did. What is left behind is an orphan file, which no later
    // profile inherits because the id it answers to is never handed out again.
    const target = writableStorage(this.storage);
    await optional(() => target?.remove(progressFile(id)) ?? Promise.resolve());
  }

  /**
   * An id derived from the name that no profile has had before.
   *
   * Not merely one no profile has now. Positions are filed under the id alone,
   * so an id handed out twice gives the second profile whatever the first left
   * behind — and something can be left behind: the cleanup in {@link remove}
   * is best effort, and a page turn that resolved the old profile before it was
   * deleted can land its write afterwards. So an id is passed over while it is
   * live, while it is recorded as retired, and while a progress file still
   * answers to it. The file check covers ids retired before the list existed or
   * since fallen off the end of it; the list covers the write that has not
   * landed yet, which no check for a file could see.
   */
  private async unusedId(name: string, taken: Set<string>): Promise<string> {
    for (const candidate of candidateIds(name)) {
      if (taken.has(candidate)) continue;

      // Refused rather than guessed when storage cannot say: assuming there is
      // no file is exactly how one reader's positions reach another.
      const orphan = await reading("a reading position", () =>
        this.storage.head(progressFile(candidate)),
      );
      if (!orphan) return candidate;
    }

    throw new Error("could not allocate a profile id");
  }

  /** The profiles, the implicit default among them, and the retired ids. */
  private async state(): Promise<Stored> {
    const stored = await this.stored();
    return stored.profiles.length > 0
      ? stored
      : { ...stored, profiles: [defaultProfile()] };
  }

  /**
   * The profile file, or an empty one where there is none.
   *
   * Storage that cannot be read is *not* treated as an empty list, unlike
   * almost everywhere else in the app. The reason is that the answer decides
   * which profile a request belongs to, and falling back to the implicit
   * default would resolve every reader to `default` — so the next page turn
   * would write one person's position into a file belonging to nobody, and the
   * position it displaced would be gone. Failing to render the shelf is
   * recoverable; quietly writing into the wrong file is not.
   *
   * A file that is there but is not a profile list is refused the same way,
   * and for a second reason as well as that one: the next change rewrites the
   * file from what was read, so reading it as empty would have the next profile
   * created replace every profile there was.
   */
  private async stored(): Promise<Stored> {
    const bytes = await reading("the profile list", () =>
      this.storage.readBytes(PROFILES_FILE),
    );
    if (!bytes) return { profiles: [], retired: [] };

    let parsed: Profiles;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as Profiles;
      if (!Array.isArray(parsed?.profiles)) {
        throw new Error("the file holds no list of profiles");
      }
    } catch (cause) {
      throw new LibraryUnavailableError("reading the profile list", cause);
    }

    return {
      profiles: parsed.profiles.filter(
        (profile) =>
          typeof profile?.id === "string" &&
          isProfileId(profile.id) &&
          typeof profile.name === "string",
      ),
      retired: Array.isArray(parsed.retired)
        ? parsed.retired.filter(
            (id) => typeof id === "string" && isProfileId(id),
          )
        : [],
    };
  }

  private async save(profiles: Profile[], retired: string[]): Promise<void> {
    const target = writableStorage(this.storage);
    if (!target) throw new ReadOnlyLibraryError();

    // Left out while empty, so a library nobody has deleted from keeps writing
    // the file it always did.
    const file: Profiles = {
      version: STATE_VERSION,
      profiles,
      ...(retired.length > 0 ? { retired } : {}),
    };
    await writing("the profile list", () =>
      target.write(PROFILES_FILE, encode(file), "application/json"),
    );
  }
}
