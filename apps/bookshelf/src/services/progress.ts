import {
  type BookProgress,
  type Progress,
  progressFile,
  STATE_VERSION,
  type Storage,
  writableStorage,
} from "@bookshelf/core";

export type { BookProgress } from "@bookshelf/core";

/**
 * How far each profile got in each book.
 *
 * One object per profile rather than one per book: a page turn costs a read
 * and a write either way, and this way the shelf can show every position it
 * knows about in a single request.
 *
 * Two devices reading as the same profile is last-write-wins. The client only
 * sends a position it believes is newer than the one it was given, which makes
 * that lossless in every case except genuinely simultaneous reading — and the
 * reader that loses gets the other's position on its next load.
 */
export class ProgressService {
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  get writable(): boolean {
    return writableStorage(this.storage) !== null;
  }

  /** Every position this profile has, keyed by book id. */
  async all(profileId: string): Promise<Record<string, BookProgress>> {
    const bytes = await this.storage.readBytes(progressFile(profileId));
    if (!bytes) return {};

    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Progress;
      return parsed.books ?? {};
    } catch {
      return {};
    }
  }

  async get(profileId: string, bookId: string): Promise<BookProgress | null> {
    return (await this.all(profileId))[bookId] ?? null;
  }

  /** Records a position. False where the library cannot be written to. */
  async save(
    profileId: string,
    bookId: string,
    position: { cfi?: string; href?: string },
  ): Promise<boolean> {
    const target = writableStorage(this.storage);
    if (!target) return false;

    const books = await this.all(profileId);
    books[bookId] = {
      ...(position.cfi ? { cfi: position.cfi } : {}),
      ...(position.href ? { href: position.href } : {}),
      updatedAt: new Date().toISOString(),
    };

    await target.write(
      progressFile(profileId),
      new TextEncoder().encode(
        JSON.stringify({ version: STATE_VERSION, books } satisfies Progress),
      ),
      "application/json",
    );
    return true;
  }

  /** Forgets one book, or every book when no id is given. */
  async clear(profileId: string, bookId?: string): Promise<boolean> {
    const target = writableStorage(this.storage);
    if (!target) return false;

    if (!bookId) {
      await target.remove(progressFile(profileId));
      return true;
    }

    const books = await this.all(profileId);
    if (!(bookId in books)) return true;

    delete books[bookId];
    await target.write(
      progressFile(profileId),
      new TextEncoder().encode(
        JSON.stringify({ version: STATE_VERSION, books } satisfies Progress),
      ),
      "application/json",
    );
    return true;
  }
}
