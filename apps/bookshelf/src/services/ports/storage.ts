/**
 * Everything the app needs from a storage provider, and nothing specific to
 * one. R2 is the only implementation today; S3, a filesystem, or plain HTTP
 * range requests can satisfy the same contract.
 *
 * Note there is no `list`: the catalog is what enumerates the library, so
 * discovering books by walking the bucket is not something callers may do.
 */
export type StoredObject = {
  key: string;
  size: number;
  /** Strong validator for this version, already quoted for an ETag header. */
  etag: string;
  uploadedAt: Date;
  contentType?: string;
};

export type StoredContent = {
  object: StoredObject;
  /**
   * Null when a conditional read matched and the provider skipped the body,
   * which lets the caller answer 304 without transferring anything.
   */
  body: ReadableStream<Uint8Array> | null;
};

export interface Storage {
  /** Metadata only. Null if the object does not exist. */
  head(key: string): Promise<StoredObject | null>;

  /** Streams an object, optionally skipping the body when the ETag matches. */
  read(
    key: string,
    options?: { ifNoneMatch?: string },
  ): Promise<StoredContent | null>;

  /** Reads a whole object into memory. For small objects: catalogs, metadata. */
  readBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null>;

  /**
   * Reads a byte range. This is what makes it possible to pull one chapter out
   * of a 42 MB archive without transferring the archive.
   */
  readRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer> | null>;
}
