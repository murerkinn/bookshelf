/**
 * The difference between a library that holds nothing and one that could not be
 * reached.
 *
 * Every service already distinguishes present from absent, carefully: an
 * unpublished catalog is an empty shelf, a library with no profile file has one
 * implicit profile, a book nobody has opened has no saved position. All of those
 * are normal, and none of them is an error.
 *
 * A third state was missing. Storage that is there but failing — a network
 * blip, an R2 hiccup, a disk that has gone away — used to arrive as whatever
 * the provider happened to throw, which is indistinguishable from a bug and
 * takes a page down with it. Naming it is what lets each caller decide, because
 * the right answer genuinely differs: a reading position that cannot be read
 * costs nothing, since the browser kept its own copy, while a catalog that
 * cannot be read has no honest substitute.
 */
export class LibraryUnavailableError extends Error {
  constructor(action: string, cause: unknown) {
    super(`The library could not be reached while ${action}.`, { cause });
    this.name = "LibraryUnavailableError";
  }
}

export function isUnavailable(
  error: unknown,
): error is LibraryUnavailableError {
  return error instanceof LibraryUnavailableError;
}

/**
 * Runs a read against storage, naming what it was reading if it fails.
 *
 * Deliberately only around the call to the provider, never around the parsing
 * of what it returned: a file that cannot be read and a file whose contents are
 * nonsense are different problems with different answers, and the services
 * already answer the second one.
 */
export async function reading<T>(
  what: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    throw new LibraryUnavailableError(`reading ${what}`, cause);
  }
}

/** The same, for the writes the app makes to keep its own state. */
export async function writing<T>(
  what: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (cause) {
    throw new LibraryUnavailableError(`saving ${what}`, cause);
  }
}

/**
 * Runs something whose failure does not matter, and reports that it failed.
 *
 * For the cache in front of storage. It exists to save a read, so a cache that
 * is broken should cost that saving and nothing else — never the answer.
 */
export async function optional<T>(
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch {
    return undefined;
  }
}

/**
 * Runs a read the page can do without, answering `undefined` where the library
 * could not be reached.
 *
 * Only that. A page rendering less than it wanted to is a reasonable answer to
 * an outage and a terrible one to a bug, so anything else is left to throw and
 * reach the error boundary, where it is visible.
 */
export async function ifAvailable<T>(
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (error) {
    if (isUnavailable(error)) return undefined;
    throw error;
  }
}
