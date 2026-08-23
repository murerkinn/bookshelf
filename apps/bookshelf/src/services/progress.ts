import {
  type BookProgress,
  type Progress,
  progressFile,
  STATE_VERSION,
  type Storage,
  type WritableStorage,
  writableStorage,
} from "@bookshelf/core";
import { reading } from "@/services/errors";

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

  /** The file as it stands, which a caller about to rewrite it must have. */
  private async stored(
    profileId: string,
  ): Promise<Record<string, BookProgress>> {
    const bytes = await reading("a reading position", () =>
      this.storage.readBytes(progressFile(profileId)),
    );
    if (!bytes) return {};

    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Progress;
      return parsed.books ?? {};
    } catch {
      return {};
    }
  }

  /**
   * Every position this profile has, keyed by book id.
   *
   * Positions that cannot be read come back as none, because that costs
   * nothing: the shelf shows "Read" instead of "Continue", and the reader
   * reconciles whatever it is given against the copy the browser kept — newest
   * wins — so a position missing from this answer is not a position lost.
   */
  async all(profileId: string): Promise<Record<string, BookProgress>> {
    try {
      return await this.stored(profileId);
    } catch {
      return {};
    }
  }

  async get(profileId: string, bookId: string): Promise<BookProgress | null> {
    return (await this.all(profileId))[bookId] ?? null;
  }

  /**
   * Records a position. False where the library cannot be written to, and false
   * where it could not be read either — which is not the same thing as
   * {@link all} answering with none.
   *
   * The file holds every book this profile has open and is rewritten whole, so
   * writing it after a failed read would replace all of those positions with
   * this one. A reader told `false` keeps its place in the browser and tries
   * again later, which is exactly the right outcome; a reader told `true` over a
   * file that lost nine books is not.
   */
  async save(
    profileId: string,
    bookId: string,
    position: { cfi?: string; href?: string },
  ): Promise<boolean> {
    const target = writableStorage(this.storage);
    if (!target) return false;

    let books: Record<string, BookProgress>;
    try {
      books = await this.stored(profileId);
    } catch {
      return false;
    }

    books[bookId] = {
      ...(position.cfi ? { cfi: position.cfi } : {}),
      ...(position.href ? { href: position.href } : {}),
      updatedAt: new Date().toISOString(),
    };

    return this.write(target, profileId, books);
  }

  /** Forgets one book, or every book when no id is given. */
  async clear(profileId: string, bookId?: string): Promise<boolean> {
    const target = writableStorage(this.storage);
    if (!target) return false;

    if (!bookId) {
      // Nothing is read first, so there is nothing a failed read could lose.
      try {
        await target.remove(progressFile(profileId));
        return true;
      } catch {
        return false;
      }
    }

    let books: Record<string, BookProgress>;
    try {
      books = await this.stored(profileId);
    } catch {
      // Same hazard as saving: rewriting what was not read would drop the rest.
      return false;
    }
    if (!(bookId in books)) return true;

    delete books[bookId];
    return this.write(target, profileId, books);
  }

  /** Rewrites the file. False where the write did not land. */
  private async write(
    target: WritableStorage,
    profileId: string,
    books: Record<string, BookProgress>,
  ): Promise<boolean> {
    try {
      await target.write(
        progressFile(profileId),
        new TextEncoder().encode(
          JSON.stringify({ version: STATE_VERSION, books } satisfies Progress),
        ),
        "application/json",
      );
      return true;
    } catch {
      return false;
    }
  }
}
