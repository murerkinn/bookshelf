/**
 * The other half of a library.
 *
 * `catalog.ts` describes what the sync tool publishes — derived, regenerable,
 * the same for everyone. This describes what the app writes back: who is
 * reading, and how far they got. It is the only thing in the library the sync
 * tool did not put there, and so the only thing it must never take away.
 *
 * That is what {@link STATE_PREFIX} is for. Everything here lives under one
 * reserved folder, and providers exclude it from enumeration, so a `--force`
 * that empties the destination cannot also empty everyone's bookmarks.
 */

/** Bumped when either shape below changes incompatibly. */
export const STATE_VERSION = 1;

/**
 * Where app-written state lives, relative to the library root.
 *
 * Dot-prefixed because book folders are named after slugified titles and so
 * can never begin with one — the namespace is reserved by construction rather
 * than by hoping nobody publishes a book called "bookshelf".
 */
export const STATE_PREFIX = ".bookshelf/";

/** The profile list, one per library. */
export const PROFILES_FILE = `${STATE_PREFIX}profiles.json`;

/** One profile's progress across every book they have opened. */
export function progressFile(profileId: string): string {
  return `${STATE_PREFIX}progress/${profileId}.json`;
}

/** Whether a key belongs to the app rather than to the published library. */
export function isStateKey(key: string): boolean {
  return key.startsWith(STATE_PREFIX);
}

/**
 * The profile every library has before anyone has configured anything.
 *
 * It is not written anywhere until there is a reason to write it — a rename, a
 * second profile, a saved position. A library nobody has touched holds no state
 * file at all, which is what keeps a read-only destination perfectly usable.
 */
export const DEFAULT_PROFILE_ID = "default";
export const DEFAULT_PROFILE_NAME = "Reader";

export type Profile = {
  /** Stable, and used as a file name, so restricted to `[a-z0-9-]`. */
  id: string;
  name: string;
  createdAt: string;
};

export type Profiles = {
  version: number;
  profiles: Profile[];
};

/**
 * Where one reader got to in one book.
 *
 * Every field but the timestamp is optional because a position means different
 * things in different formats, and a book only ever has one of them: `cfi` and
 * `href` are EPUB-shaped, `page` is what a PDF has instead. They are kept flat
 * rather than as a discriminated union so that the file on disk is unchanged
 * for every book already in a library, and so that a reader meeting a kind of
 * position it does not understand ignores it and starts at the beginning —
 * which is already what it does for a book nobody has opened. That is why
 * {@link STATE_VERSION} does not move when a kind is added.
 */
export type BookProgress = {
  /** An EPUB CFI: the position, precise to the character. */
  cfi?: string;
  /** The spine href it falls in, for showing where someone is without parsing. */
  href?: string;
  /** A PDF page, counting from one. */
  page?: number;
  /** ISO 8601. Decides which device wins when two have been reading. */
  updatedAt: string;
};

/** Everything one profile has read, keyed by book id. */
export type Progress = {
  version: number;
  books: Record<string, BookProgress>;
};

export function defaultProfile(): Profile {
  return {
    id: DEFAULT_PROFILE_ID,
    name: DEFAULT_PROFILE_NAME,
    createdAt: new Date(0).toISOString(),
  };
}

/** Profile ids become file names, so they are constrained rather than trusted. */
export function isProfileId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}
