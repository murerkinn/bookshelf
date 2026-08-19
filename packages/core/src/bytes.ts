/**
 * A source of bytes that can be read at an offset.
 *
 * The ZIP reader is written against this rather than against a buffer or a
 * storage provider, because the two callers differ in exactly this respect:
 * the sync CLI holds a whole book in memory, while the app pulls one chapter
 * out of a 42 MB archive over ranged reads and must never transfer the rest.
 */
export type ByteSource = {
  /**
   * Total length of the source. Called only when a reader needs to locate
   * something relative to the end, so a provider that has to ask the network
   * for it pays that cost only then.
   */
  size(): Promise<number>;

  /**
   * Reads up to `length` bytes at `offset`, clamped to what exists. Null when
   * nothing could be read at all — a missing object, or an offset past the end.
   */
  read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer> | null>;
};

/** A source over bytes already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    async size() {
      return bytes.byteLength;
    },

    async read(offset, length) {
      if (offset < 0 || length <= 0 || offset >= bytes.byteLength) return null;
      // Clamped rather than refused, so a speculative over-read behaves the
      // same here as it does against object storage.
      const end = Math.min(offset + length, bytes.byteLength);
      return bytes.subarray(offset, end) as Uint8Array<ArrayBuffer>;
    },
  };
}

/**
 * A source over ranged reads. `size` may be a number when the caller already
 * knows it, or a function when finding out costs a round trip.
 */
export function rangedSource(
  size: number | (() => Promise<number>),
  read: ByteSource["read"],
): ByteSource {
  return {
    async size() {
      return typeof size === "number" ? size : await size();
    },
    read,
  };
}
