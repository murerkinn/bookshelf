import type {
  Storage,
  StoredContent,
  StoredObject,
} from "@/services/ports/storage";

function describe(object: R2Object): StoredObject {
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

/** Cloudflare R2, via a Worker binding. */
export class R2Storage implements Storage {
  constructor(private readonly bucket: R2Bucket) {}

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
      body: "body" in object ? object.body : null,
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
}
