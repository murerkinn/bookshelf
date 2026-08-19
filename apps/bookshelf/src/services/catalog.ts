import {
  type Book,
  type BookFormat,
  CATALOG_FILE,
  type Catalog,
} from "@bookshelf/core";
import type { ResponseCache } from "@/services/ports/cache";
import type { Storage } from "@/services/ports/storage";

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

const CACHE_KEY = "https://bookshelf.internal/catalog";

/**
 * In-isolate memo, the tier in front of the response cache. A warm isolate
 * answers with no I/O at all.
 */
let memo: { books: Book[]; expiresAt: number } | null = null;

/** Discards the memo. Exists so tests are not order-dependent. */
export function resetCatalogMemo(): void {
  memo = null;
}

export class CatalogService {
  constructor(
    private readonly storage: Storage,
    private readonly cache: ResponseCache,
  ) {}

  async all(): Promise<Book[]> {
    const now = Date.now();
    if (memo && memo.expiresAt > now) return memo.books;

    const cached = await this.cache.match(CACHE_KEY);
    if (cached) {
      const books = (await cached.json()) as Book[];
      memo = { books, expiresAt: now + TTL_SECONDS * 1000 };
      return books;
    }

    const books = await this.load();
    memo = { books, expiresAt: now + TTL_SECONDS * 1000 };
    this.cache.put(
      CACHE_KEY,
      new Response(JSON.stringify(books), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${TTL_SECONDS}`,
        },
      }),
    );
    return books;
  }

  private async load(): Promise<Book[]> {
    const bytes = await this.storage.readBytes(CATALOG_FILE);
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
