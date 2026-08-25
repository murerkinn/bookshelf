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

/**
 * The books, and when the sync tool published them.
 *
 * `generatedAt` is the only timestamp a library has — nothing records when an
 * individual book was added — so it is what anything needing a date has to use.
 * Optional because a catalog published before the field existed does not carry
 * one, and an empty shelf has no date at all.
 */
export type Shelf = { books: Book[]; generatedAt?: string };

/**
 * The suffix names the shape, not the contents. A cached entry outlives the
 * deploy that wrote it, and this cache once held a bare array; a new key is how
 * that entry is ignored rather than parsed as something it is not.
 */
const CACHE_KEY = "https://bookshelf.internal/catalog/shelf";

/**
 * In-isolate memo, the tier in front of the response cache. A warm isolate
 * answers with no I/O at all.
 *
 * Kept past its expiry rather than discarded, because an expired catalog is the
 * best answer available when a refresh fails: the books in it are real, and a
 * shelf a minute out of date beats an error page.
 */
let memo: { shelf: Shelf; expiresAt: number } | null = null;

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
   * The catalog as published: every book, and the date on it.
   *
   * Throws {@link LibraryUnavailableError} only when there is nothing to answer
   * with at all — storage is unreachable and no catalog has been read yet. Once
   * one has, a failure serves that instead, because the shelf staying up is
   * worth more than it being current.
   */
  async shelf(): Promise<Shelf> {
    const now = Date.now();
    if (memo && memo.expiresAt > now) return memo.shelf;

    const cached = await this.cached();
    if (cached) {
      memo = { shelf: cached, expiresAt: now + TTL_SECONDS * 1000 };
      return cached;
    }

    try {
      const shelf = await this.load();
      memo = { shelf, expiresAt: now + TTL_SECONDS * 1000 };
      this.store(shelf);
      return shelf;
    } catch (error) {
      if (!isUnavailable(error) || !memo) throw error;

      // Serve what was last read, and stop asking for a moment: every keystroke
      // in the search box re-renders the page, and a failing storage should not
      // be asked once per keystroke.
      memo = { shelf: memo.shelf, expiresAt: now + STALE_SECONDS * 1000 };
      return memo.shelf;
    }
  }

  /** Every book in the library. */
  async all(): Promise<Book[]> {
    return (await this.shelf()).books;
  }

  /**
   * The catalog as the response cache has it, or undefined for anything that
   * went wrong — a miss, an unreachable cache, an entry that will not parse.
   * None of those is a reason not to read the real thing.
   */
  private async cached(): Promise<Shelf | undefined> {
    const hit = await optional(() => this.cache.match(CACHE_KEY));
    if (!hit) return undefined;

    const shelf = await optional(async () => (await hit.json()) as Shelf);
    // An entry that parses as JSON but is not a shelf is a miss, not a shelf
    // with no books in it.
    return Array.isArray(shelf?.books) ? shelf : undefined;
  }

  /** Fills the cache for the next isolate. Never the caller's problem. */
  private store(shelf: Shelf): void {
    void optional(async () =>
      this.cache.put(
        CACHE_KEY,
        new Response(JSON.stringify(shelf), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${TTL_SECONDS}`,
          },
        }),
      ),
    );
  }

  private async load(): Promise<Shelf> {
    const bytes = await reading("the catalog", () =>
      this.storage.readBytes(CATALOG_FILE),
    );
    // An unpublished catalog is an empty shelf, not an error: the page says so.
    if (!bytes) return { books: [] };

    try {
      const catalog = JSON.parse(new TextDecoder().decode(bytes)) as Catalog;
      return {
        books: [...(catalog.books ?? [])].sort((a, b) =>
          a.title.localeCompare(b.title),
        ),
        generatedAt: catalog.generatedAt,
      };
    } catch {
      return { books: [] };
    }
  }

  async find(id: string): Promise<Book | null> {
    return (await this.all()).find((book) => book.id === id) ?? null;
  }

  async search(query: string): Promise<Book[]> {
    return searchBooks(await this.all(), query);
  }
}

/**
 * What a query matches, over books already in hand.
 *
 * Split out of the service because the shelf is not the only thing that
 * searches — the OPDS catalog does too, and the two disagreeing about what a
 * query means would be a bug nobody would think to look for.
 */
export function searchBooks(books: Book[], query: string): Book[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return books;

  return books.filter((book) =>
    [book.title, book.authors.join(" "), book.publisher ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

/** The format a reader should open, preferring what renders best. */
export function readableFormat(book: Book): BookFormat | undefined {
  return (
    book.formats.find((f) => f.format === "epub") ??
    book.formats.find((f) => f.format === "pdf") ??
    book.formats[0]
  );
}
