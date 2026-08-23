import {
  type ByteSource,
  rangedSource,
  readZipDirectory,
  readZipEntry,
  type Storage,
  type ZipDirectory,
  type ZipEntry,
} from "@bookshelf/core";
import type { ResponseCache } from "@/services/ports/cache";

/**
 * A book's archive layout never changes, so its central directory is worth
 * holding on to: reading it costs two ranged reads, and every chapter the
 * reader opens would otherwise repeat them.
 */
const DIRECTORY_TTL_SECONDS = 3600;

/** Few enough to bound isolate memory, more than one reader needs at a time. */
const MEMO_LIMIT = 8;
const memo = new Map<string, ZipDirectory>();

function remember(key: string, directory: ZipDirectory): void {
  if (memo.size >= MEMO_LIMIT) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, directory);
}

/** Reads the files inside a book's archive, one at a time. */
export class BookContentService {
  private readonly storage: Storage;
  private readonly cache: ResponseCache;

  constructor(storage: Storage, cache: ResponseCache) {
    this.storage = storage;
    this.cache = cache;
  }

  /**
   * The archive as bytes the ZIP reader can range over. Its size is looked up
   * lazily, so reading an entry — which needs only offsets — costs no HEAD.
   */
  private source(key: string): ByteSource {
    return rangedSource(
      async () => (await this.storage.head(key))?.size ?? 0,
      (offset, length) => this.storage.readRange(key, offset, length),
    );
  }

  private cacheKey(key: string): string {
    return `https://bookshelf.internal/zip/${encodeURIComponent(key)}`;
  }

  /** Returns null when the object is missing or is not a usable archive. */
  private async directory(key: string): Promise<ZipDirectory | null> {
    const remembered = memo.get(key);
    if (remembered) return remembered;

    const stored = await this.cache.match(this.cacheKey(key));
    if (stored) {
      const entries = (await stored.json()) as Record<string, ZipEntry>;
      const directory: ZipDirectory = new Map(Object.entries(entries));
      remember(key, directory);
      return directory;
    }

    return this.reread(key);
  }

  /**
   * Reads the directory from the object itself, replacing whatever was kept.
   *
   * Both copies are replaced rather than dropped: leaving the response cache
   * holding the old one would just hand it back on the next request.
   */
  private async reread(key: string): Promise<ZipDirectory | null> {
    const directory = await readZipDirectory(this.source(key));
    if (!directory) return null;
    remember(key, directory);

    this.cache.put(
      this.cacheKey(key),
      new Response(JSON.stringify(Object.fromEntries(directory)), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${DIRECTORY_TTL_SECONDS}`,
        },
      }),
    );

    return directory;
  }

  /** Reads one file out of a book. Null if either the book or it is missing. */
  async entry(
    key: string,
    entryPath: string,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    const directory = await this.directory(key);
    const entry = directory?.get(entryPath);
    if (!entry) return null;

    const bytes = await readZipEntry(this.source(key), entry);
    if (bytes) return bytes;

    // The directory said there was an entry here and there was not. The
    // likely reason is that the directory is one we kept and the object has
    // been replaced since — republishing a book does exactly that, and the
    // key does not change — so read the directory again and try once more.
    //
    // Only on a read that failed, never on an entry the directory does not
    // list at all: that is an ordinary 404, and re-reading on those would let
    // any made-up path cost two extra reads.
    const fresh = await this.reread(key);
    const moved = fresh?.get(entryPath);
    if (!moved || moved.localOffset === entry.localOffset) return null;

    return readZipEntry(this.source(key), moved);
  }

  /**
   * Locates the package document, which is what the reader is pointed at.
   *
   * epub.js decides how to open a book from its URL extension, and treats a URL
   * with no extension as an unpacked directory — but a base ending in `.epub/`
   * still parses as the `epub` extension, which would send it off to download
   * the whole archive. Handing it the `.opf` URL selects the right mode and
   * makes it fetch chapters one at a time.
   */
  async packageDocument(key: string): Promise<string | null> {
    const container = await this.entry(key, "META-INF/container.xml");
    if (!container) return null;

    return (
      new TextDecoder()
        .decode(container)
        .match(/<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]*)"/i)?.[1] ?? null
    );
  }
}
