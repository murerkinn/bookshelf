import {
  type ByteRange,
  clampRange,
  contentTypeFor,
  normaliseEtag,
  type Storage,
  type StoredContent,
  type StoredObject,
} from "@bookshelf/core";
import type { ResponseCache } from "@/services/ports/cache";
import type { RateLimits } from "@/services/ports/limits";

/**
 * A library in memory, implementing the provider contract.
 *
 * The app's services are written against `Storage` and nothing else, so this is
 * all it takes to exercise them — and being able to hand them a library that
 * cannot be written to, or one that fails, is the point: those are deliberate
 * behaviours that no provider on this machine would reproduce on demand.
 *
 * It counts what was asked of it, because some of what the services promise is
 * about how little they ask.
 */
export type MemoryLibrary = {
  storage: Storage;
  /** Every call made, in order. */
  reads: { op: string; key: string; [detail: string]: unknown }[];
  /** Every write and delete, in order. */
  writes: { key: string; removed?: boolean; contentType?: string }[];
  contents(): Record<string, string>;
  json<T = unknown>(key: string): T;
  has(key: string): boolean;
  /** Replaces what is at a key, as republishing a book does. */
  put(key: string, value: string | Uint8Array): void;
  /**
   * Makes operations throw, as a bucket that has gone away does. Named ones
   * only, if any are named — `fail("readBytes")` is a library that can still be
   * written to, which is the shape that turns a rewritten file into a lost one.
   * The contents stay put either way, because an outage deletes nothing.
   */
  fail(...ops: string[]): void;
  heal(): void;
};

export function memoryStorage(
  objects: Record<string, string | Uint8Array> = {},
  { writable = true, failing = false } = {},
): MemoryLibrary {
  // Either every operation or a named few, because which ones fail is the whole
  // question in places: a read that fails while writes still work is how a
  // rewritten file loses everything it was not able to read first.
  let broken: true | Set<string> | null = failing ? true : null;
  const refuse = (op: string): void => {
    if (broken === true || broken?.has(op)) {
      throw new Error(`storage is unreachable (${op})`);
    }
  };

  const held = new Map<string, Uint8Array>(
    Object.entries(objects).map(([key, value]) => [
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    ]),
  );
  const reads: MemoryLibrary["reads"] = [];
  const writes: MemoryLibrary["writes"] = [];

  /** The bytes at a key, which every caller below has already checked for. */
  const bytesAt = (key: string): Uint8Array => held.get(key) as Uint8Array;

  const describe = (key: string): StoredObject => ({
    key,
    size: bytesAt(key).byteLength,
    // Derived from the contents, so replacing an object changes its validator.
    etag: `"${bytesAt(key).byteLength.toString(16)}-${bytesAt(key)[0] ?? 0}"`,
    uploadedAt: new Date(0),
    contentType: contentTypeFor(key),
  });

  const asArrayBuffer = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
    bytes as Uint8Array<ArrayBuffer>;

  const storage: Storage = {
    async head(key) {
      reads.push({ op: "head", key });
      refuse("head");
      return held.has(key) ? describe(key) : null;
    },

    async read(key, options): Promise<StoredContent | null> {
      reads.push({ op: "read", key, options });
      refuse("read");
      if (!held.has(key)) return null;

      const object = describe(key);
      if (
        options?.ifNoneMatch &&
        normaliseEtag(options.ifNoneMatch) === normaliseEtag(object.etag)
      ) {
        return { object, body: null };
      }

      const range: ByteRange | null = options?.range
        ? clampRange(options.range, object.size)
        : null;
      if (options?.range && !range) return { object, body: null };

      const bytes = range
        ? bytesAt(key).subarray(range.offset, range.offset + range.length)
        : bytesAt(key);

      return {
        object,
        body: new Response(asArrayBuffer(bytes)).body,
        ...(range ? { range } : {}),
      };
    },

    async readBytes(key) {
      reads.push({ op: "readBytes", key });
      refuse("readBytes");
      const bytes = held.get(key);
      return bytes ? asArrayBuffer(bytes) : null;
    },

    async readRange(key, offset, length) {
      reads.push({ op: "readRange", key, offset, length });
      refuse("readRange");
      if (length <= 0 || !held.has(key)) return null;

      const range = clampRange({ offset, length }, bytesAt(key).byteLength);
      if (!range) return null;
      return asArrayBuffer(
        bytesAt(key).subarray(range.offset, range.offset + range.length),
      );
    },
  };

  if (writable) {
    storage.write = async (key, bytes, contentType) => {
      writes.push({ key, contentType });
      refuse("write");
      held.set(key, bytes);
    };
    storage.remove = async (key) => {
      writes.push({ key, removed: true });
      refuse("remove");
      held.delete(key);
    };
  }

  return {
    storage,
    reads,
    writes,
    contents() {
      return Object.fromEntries(
        [...held].map(([key, value]) => [key, new TextDecoder().decode(value)]),
      );
    },
    json<T>(key: string): T {
      const value = held.get(key);
      return (value ? JSON.parse(new TextDecoder().decode(value)) : null) as T;
    },
    has(key) {
      return held.has(key);
    },
    put(key, value) {
      held.set(
        key,
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      );
    },
    fail(...ops) {
      broken = ops.length > 0 ? new Set(ops) : true;
    },
    heal() {
      broken = null;
    },
  };
}

/**
 * A response cache that holds nothing.
 *
 * The tier in front of storage is the Workers Cache API in production, and a
 * service must work without it — `next dev` and the Node server both run with
 * one that never hits.
 */
export function nullCache(): ResponseCache {
  return {
    async match() {
      return undefined;
    },
    put() {},
  };
}

/** A cache whose every operation throws, which must never break a read. */
export function brokenCache(): ResponseCache {
  return {
    async match(): Promise<Response | undefined> {
      throw new Error("the cache is unreachable");
    },
    put() {
      throw new Error("the cache is unreachable");
    },
  };
}

/** A response cache that remembers, so the tiers in front of storage show up. */
export function recordingCache(): {
  calls: { op: string; key: string; hit?: boolean }[];
  size: () => number;
  cache: ResponseCache;
} {
  const held = new Map<string, Response>();
  const calls: { op: string; key: string; hit?: boolean }[] = [];

  return {
    calls,
    size: () => held.size,
    cache: {
      async match(key) {
        calls.push({ op: "match", key, hit: held.has(key) });
        return held.get(key)?.clone();
      },
      put(key, response) {
        calls.push({ op: "put", key });
        held.set(key, response);
      },
    },
  };
}

/**
 * The value, or a failed test.
 *
 * Test code knows things the compiler does not — that a position just saved can
 * be read back, that an entry just written is there. This states that as an
 * assertion rather than as a cast, so a wrong assumption fails loudly at the
 * line that made it.
 */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`expected a ${what}, got ${String(value)}`);
  }
  return value;
}

/**
 * Limiters that remember what they were asked, and refuse after a while.
 *
 * The counts are how many of each allowance are left, so `{ r2: 0 }` is a
 * visitor who has already used the minute up — which is the state worth
 * testing, and the only one a test would otherwise have to make thirty requests
 * to reach. `asked` is in order, because for a download the order is part of
 * the contract: the cheap allowance is spent before the expensive one.
 */
export function recordingLimits({
  r2 = Number.POSITIVE_INFINITY,
  download = Number.POSITIVE_INFINITY,
}: {
  r2?: number;
  download?: number;
} = {}): {
  asked: { allowance: "r2" | "download"; visitor: string }[];
  limits: RateLimits;
} {
  const asked: { allowance: "r2" | "download"; visitor: string }[] = [];
  const left = { r2, download };

  const ask = async (
    allowance: "r2" | "download",
    visitor: string,
  ): Promise<boolean> => {
    asked.push({ allowance, visitor });
    if (left[allowance] <= 0) return false;
    left[allowance] -= 1;
    return true;
  };

  return {
    asked,
    limits: {
      allowsR2: (visitor) => ask("r2", visitor),
      allowsDownload: (visitor) => ask("download", visitor),
    },
  };
}
