import type { ResponseCache } from "@/services/ports/cache";

/**
 * The Workers Cache API, shared by every isolate serving this location.
 *
 * `caches.open()` rather than the `caches.default` Cloudflare also offers: the
 * runtime types leave `CacheStorage` to lib.dom, which declares no `default`,
 * and a named cache keeps these entries out of the CDN's own namespace anyway.
 */
export class WorkersCache implements ResponseCache {
  private readonly cache: Cache;
  private readonly waitUntil: (work: Promise<unknown>) => void;

  constructor(cache: Cache, waitUntil: (work: Promise<unknown>) => void) {
    this.cache = cache;
    this.waitUntil = waitUntil;
  }

  async match(key: string): Promise<Response | undefined> {
    return this.cache.match(key);
  }

  put(key: string, response: Response): void {
    // Deferred past the response: the reader should never wait on a cache write.
    this.waitUntil(this.cache.put(key, response));
  }
}

/** Null under `next dev`, which runs in Node rather than workerd. */
export async function openWorkersCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  return caches.open("bookshelf");
}
