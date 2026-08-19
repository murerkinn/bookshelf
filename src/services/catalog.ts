import type { ResponseCache } from "@/services/ports/cache";
import type { Storage } from "@/services/ports/storage";

/** One downloadable file inside a book's folder. */
export type BookFormat = {
  /** Lower-case extension, e.g. `epub`. */
  format: string;
  /** File name within the book's folder, e.g. `book.epub`. */
  file: string;
  size: number;
};

/**
 * A book, as recorded in its folder's `metadata.json` and copied into the
 * catalog. Everything here comes from the book's own package metadata, so no
 * part of the app has to infer meaning from a file name.
 */
export type Book = {
  /** Folder name in the bucket, and the book's identity in URLs. */
  id: string;
  title: string;
  authors: string[];
  publisher?: string;
  /** Publication date as recorded by the publisher, often just a year. */
  published?: string;
  language?: string;
  identifier?: string;
  description?: string;
  /** Cover file name within the folder; absent when the book has none. */
  cover?: string;
  formats: BookFormat[];
};

export type Catalog = {
  version: number;
  generatedAt?: string;
  books: Book[];
};

export const CATALOG_KEY = "catalog.json";
export const METADATA_FILE = "metadata.json";

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
    const bytes = await this.storage.readBytes(CATALOG_KEY);
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

/** The key an object inside a book's folder lives at. */
export function bookKey(id: string, file: string): string {
  return `${id}/${file}`;
}

/** The format a reader should open, preferring what renders best. */
export function readableFormat(book: Book): BookFormat | undefined {
  return (
    book.formats.find((f) => f.format === "epub") ??
    book.formats.find((f) => f.format === "pdf") ??
    book.formats[0]
  );
}
