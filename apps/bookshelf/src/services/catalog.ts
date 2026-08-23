import {
  type Book,
  type BookFormat,
  CATALOG_FILE,
  type Catalog,
  type Storage,
} from "@bookshelf/core";
import { isUnavailable, optional, reading } from "@/services/errors";
import type { ResponseCache } from "@/services/ports/cache";

/**
 * What a published library looks like is a contract with the sync tool, so it
 * lives in @bookshelf/core rather than being declared here and there. Re-exported
 * so the rest of the app still has one place to import a book from.
 */
export type { Book, BookFormat, Catalog } from "@bookshelf/core";
export { bookKey } from "@bookshelf/core";

/**
 * How long a catalog is reused. Every search keystroke re-renders the page, so
 * serving those renders from a cached catalog is the difference between one
 * round trip to storage and none. Short enough that a newly published catalog
 * appears on its own shortly after.
 */
const TTL_SECONDS = 60;

/**
 * How long a catalog that could not be refreshed goes on being served.
 *
 * Short, because it is stale by definition, and not zero because the
 * alternative is asking a failing storage again on every keystroke. One attempt
 * per isolate per this, rather than one per render.
 */
const STALE_SECONDS = 10;

const CACHE_KEY = "https://bookshelf.internal/catalog";

/**
 * In-isolate memo, the tier in front of the response cache. A warm isolate
 * answers with no I/O at all.
 *
 * Kept past its expiry rather than discarded, because an expired catalog is the
 * best answer available when a refresh fails: the books in it are real, and a
 * shelf a minute out of date beats an error page.
 */
let memo: { books: Book[]; expiresAt: number } | null = null;

/** Discards the memo. Exists so tests are not order-dependent. */
export function resetCatalogMemo(): void {
  memo = null;
}

export class CatalogService {
  private readonly storage: Storage;
  private readonly cache: ResponseCache;

  constructor(storage: Storage, cache: ResponseCache) {
    this.storage = storage;
    this.cache = cache;
  }

  /**
   * Every book in the library.
   *
   * Throws {@link LibraryUnavailableError} only when there is nothing to answer
   * with at all — storage is unreachable and no catalog has been read yet. Once
   * one has, a failure serves that instead, because the shelf staying up is
   * worth more than it being current.
   */
  async all(): Promise<Book[]> {
    const now = Date.now();
    if (memo && memo.expiresAt > now) return memo.books;

    const cached = await this.cached();
    if (cached) {
      memo = { books: cached, expiresAt: now + TTL_SECONDS * 1000 };
      return cached;
    }

    try {
      const books = await this.load();
      memo = { books, expiresAt: now + TTL_SECONDS * 1000 };
      this.store(books);
      return books;
    } catch (error) {
      if (!isUnavailable(error) || !memo) throw error;

      // Serve what was last read, and stop asking for a moment: every keystroke
      // in the search box re-renders the page, and a failing storage should not
      // be asked once per keystroke.
      memo = { books: memo.books, expiresAt: now + STALE_SECONDS * 1000 };
      return memo.books;
    }
  }

  /**
   * The catalog as the response cache has it, or undefined for anything that
   * went wrong — a miss, an unreachable cache, an entry that will not parse.
   * None of those is a reason not to read the real thing.
   */
  private async cached(): Promise<Book[] | undefined> {
    const hit = await optional(() => this.cache.match(CACHE_KEY));
    if (!hit) return undefined;
    return optional(async () => (await hit.json()) as Book[]);
  }

  /** Fills the cache for the next isolate. Never the caller's problem. */
  private store(books: Book[]): void {
    void optional(async () =>
      this.cache.put(
        CACHE_KEY,
        new Response(JSON.stringify(books), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${TTL_SECONDS}`,
          },
        }),
      ),
    );
  }

  private async load(): Promise<Book[]> {
    const bytes = await reading("the catalog", () =>
      this.storage.readBytes(CATALOG_FILE),
    );
    // An unpublished catalog is an empty shelf, not an error: the page says so.
    if (!bytes) return [];

    try {
      const catalog = JSON.parse(new TextDecoder().decode(bytes)) as Catalog;
      return [...(catalog.books ?? [])].sort((a, b) =>
        a.title.localeCompare(b.title),
      );
    } catch {
      return [];
    }
  }

  async find(id: string): Promise<Book | null> {
    return (await this.all()).find((book) => book.id === id) ?? null;
  }

  async search(query: string): Promise<Book[]> {
    const books = await this.all();
    const needle = query.trim().toLowerCase();
    if (!needle) return books;

    return books.filter((book) =>
      [book.title, book.authors.join(" "), book.publisher ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }
}

/** The format a reader should open, preferring what renders best. */
export function readableFormat(book: Book): BookFormat | undefined {
  return (
    book.formats.find((f) => f.format === "epub") ??
    book.formats.find((f) => f.format === "pdf") ??
    book.formats[0]
  );
}
