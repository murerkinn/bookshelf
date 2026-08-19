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

export type { Profile } from "@bookshelf/core";

/**
 * Enough for a household, few enough that the list stays a list. The cap is
 * here because the profile file is read on every render and rewritten whole.
 */
const MAX_PROFILES = 16;
const MAX_NAME_LENGTH = 40;

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

function uniqueId(name: string, taken: Set<string>): string {
  const base = slug(name);
  const candidate = isProfileId(base) ? base : "reader";
  if (!taken.has(candidate)) return candidate;

  for (let n = 2; n < 1000; n++) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }

  throw new Error("could not allocate a profile id");
}

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
  constructor(private readonly storage: Storage) {}

  /** Whether profiles can be changed at all, which the UI asks before offering. */
  get writable(): boolean {
    return writableStorage(this.storage) !== null;
  }

  async list(): Promise<Profile[]> {
    const stored = await this.stored();
    return stored.length > 0 ? stored : [defaultProfile()];
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
    const profiles = await this.list();
    if (profiles.length >= MAX_PROFILES) {
      throw new Error(`A library holds at most ${MAX_PROFILES} profiles.`);
    }

    const cleaned = cleanName(name) || "Reader";
    const profile: Profile = {
      id: uniqueId(cleaned, new Set(profiles.map((p) => p.id))),
      name: cleaned,
      createdAt: new Date().toISOString(),
    };

    // `profiles` may be the implicit default, which is persisted here for the
    // first time — a library with two profiles has to record both.
    await this.save([...profiles, profile]);
    return profile;
  }

  async rename(id: string, name: string): Promise<void> {
    const cleaned = cleanName(name);
    if (!cleaned) throw new Error("A profile needs a name.");

    const profiles = await this.list();
    if (!profiles.some((profile) => profile.id === id)) return;

    await this.save(
      profiles.map((profile) =>
        profile.id === id ? { ...profile, name: cleaned } : profile,
      ),
    );
  }

  /** Removes a profile and everything it had read. Never the last one. */
  async remove(id: string): Promise<void> {
    const profiles = await this.list();
    if (profiles.length <= 1) {
      throw new Error("A library keeps at least one profile.");
    }
    if (!profiles.some((profile) => profile.id === id)) return;

    await this.save(profiles.filter((profile) => profile.id !== id));

    const target = writableStorage(this.storage);
    await target?.remove(progressFile(id));
  }

  private async stored(): Promise<Profile[]> {
    const bytes = await this.storage.readBytes(PROFILES_FILE);
    if (!bytes) return [];

    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Profiles;
      return (parsed.profiles ?? []).filter(
        (profile) =>
          typeof profile?.id === "string" &&
          isProfileId(profile.id) &&
          typeof profile.name === "string",
      );
    } catch {
      // A corrupt profile file should not take the shelf down with it: the
      // library still reads, and the implicit default takes over.
      return [];
    }
  }

  private async save(profiles: Profile[]): Promise<void> {
    const target = writableStorage(this.storage);
    if (!target) throw new ReadOnlyLibraryError();

    await target.write(
      PROFILES_FILE,
      encode({ version: STATE_VERSION, profiles } satisfies Profiles),
      "application/json",
    );
  }
}
