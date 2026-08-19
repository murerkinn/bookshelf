import type {
  StoredContent,
  StoredObject,
  WritableStorage,
} from "@bookshelf/core";

/**
 * The shape of the R2 binding, structurally rather than by importing the
 * Cloudflare runtime types. A provider package should not drag a second copy of
 * workerd's global declarations into whatever consumes it, and this states
 * exactly which slice of R2 the app depends on.
 */
export type R2ObjectLike = {
  key: string;
  size: number;
  httpEtag: string;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
};

export type R2GetOptionsLike = {
  range?: { offset: number; length: number };
  onlyIf?: { etagDoesNotMatch: string };
};

export type R2PutOptionsLike = {
  httpMetadata?: { contentType?: string };
};

export type R2BucketLike = {
  head(key: string): Promise<R2ObjectLike | null>;
  get(
    key: string,
    options?: R2GetOptionsLike,
  ): Promise<
    | (R2ObjectLike & {
        body?: ReadableStream<Uint8Array>;
        arrayBuffer(): Promise<ArrayBuffer>;
      })
    | null
  >;
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: R2PutOptionsLike,
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
};

function describe(object: R2ObjectLike): StoredObject {
  return {
    key: object.key,
    size: object.size,
    etag: object.httpEtag,
    uploadedAt: object.uploaded,
    contentType: object.httpMetadata?.contentType,
  };
}

/** Bare entity tag, with any weak marker and quotes removed. */
function normaliseEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/"/g, "");
}

class R2Storage implements WritableStorage {
  constructor(private readonly bucket: R2BucketLike) {}

  async head(key: string): Promise<StoredObject | null> {
    const object = await this.bucket.head(key);
    return object ? describe(object) : null;
  }

  async read(
    key: string,
    options?: { ifNoneMatch?: string },
  ): Promise<StoredContent | null> {
    // A plain conditional object rather than the request's `Headers`: a Headers
    // instance cannot cross the RPC boundary of the binding proxy that
    // `next dev` runs behind.
    const object = await this.bucket.get(
      key,
      options?.ifNoneMatch
        ? { onlyIf: { etagDoesNotMatch: normaliseEtag(options.ifNoneMatch) } }
        : undefined,
    );
    if (!object) return null;

    return {
      object: describe(object),
      // R2 omits the body when the precondition matched.
      body: object.body ?? null,
    };
  }

  async readBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (length <= 0) return null;
    const object = await this.bucket.get(key, { range: { offset, length } });
    if (!object) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async write(
    key: string,
    bytes: Uint8Array,
    contentType?: string,
  ): Promise<void> {
    await this.bucket.put(
      key,
      bytes,
      contentType ? { httpMetadata: { contentType } } : undefined,
    );
  }

  async remove(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}

/** Cloudflare R2 as the app reads it, over a Worker binding. */
export function createStorage(bucket: R2BucketLike): WritableStorage {
  return new R2Storage(bucket);
}
