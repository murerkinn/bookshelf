/**
 * The `Range` request header, parsed.
 *
 * It lives here rather than in the route that serves it because a byte range is
 * the same idea as {@link ./bytes.ts}'s: a slice of an object, described by an
 * offset and a length. The route turns a header into one of these; a provider
 * turns one of these into a ranged read.
 *
 * Declining a range is always allowed — a server may answer any range request
 * with the whole representation — which is what {@link WHOLE} means and why so
 * many odd inputs resolve to it. Only a range that asks for bytes past the end
 * of the object is an error, because a client that asked for those has been
 * told the wrong size and should be corrected rather than quietly given
 * something else.
 */

/** A slice of an object: where it starts, and how many bytes it runs for. */
export type ByteRange = { offset: number; length: number };

export type RangeRequest =
  /** Serve the whole object, with 200. */
  | { kind: "whole" }
  /** Serve these bytes, with 206. */
  | { kind: "range"; range: ByteRange }
  /** Nothing to serve: the range starts past the end, so 416. */
  | { kind: "unsatisfiable" };

const WHOLE: RangeRequest = { kind: "whole" };
const UNSATISFIABLE: RangeRequest = { kind: "unsatisfiable" };

/**
 * Reads a `Range` header against a known object size.
 *
 * Only single ranges are honoured. A request for several at once is answered
 * with the whole object instead, because the alternative is assembling a
 * `multipart/byteranges` body, and nothing that reads this library asks for
 * more than one range at a time: a PDF viewer walks a file a chunk at a time
 * and a download resumes from one offset.
 *
 * Anything malformed is treated as absent rather than as an error, which is
 * what the specification asks for — a header a server cannot make sense of
 * should not stop it serving the thing that was requested.
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number,
): RangeRequest {
  if (!header) return WHOLE;

  // Any unit other than bytes is one this server does not implement, and an
  // unknown unit is to be ignored rather than rejected.
  const specifier = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (!specifier) return WHOLE;

  const specs = specifier[1]
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
  if (specs.length !== 1) return WHOLE;

  const parts = /^(\d*)-(\d*)$/.exec(specs[0]);
  if (!parts) return WHOLE;

  const [, first, last] = parts;
  if (first === "" && last === "") return WHOLE;

  // `bytes=-500`: the final 500 bytes, however long the object is.
  if (first === "") {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return UNSATISFIABLE;
    if (size <= 0) return UNSATISFIABLE;

    // A suffix longer than the object is the whole object, not an error.
    const offset = Math.max(0, size - suffix);
    return { kind: "range", range: { offset, length: size - offset } };
  }

  const offset = Number(first);
  if (!Number.isSafeInteger(offset)) return WHOLE;
  // An empty object has no byte to start at, so every range over it is past
  // the end.
  if (size <= 0 || offset >= size) return UNSATISFIABLE;

  // An absent last position means "to the end"; one past the end is clamped,
  // since the client is allowed not to know how long the object is.
  const requestedLast = last === "" ? size - 1 : Number(last);
  if (!Number.isSafeInteger(requestedLast)) return WHOLE;
  // A range that ends before it starts is invalid, and an invalid range is
  // ignored rather than rejected.
  if (requestedLast < offset) return WHOLE;

  const lastByte = Math.min(requestedLast, size - 1);
  return { kind: "range", range: { offset, length: lastByte - offset + 1 } };
}

/**
 * A range narrowed to what an object of this size can actually answer, or null
 * when it can answer none of it.
 *
 * Providers clamp with this rather than trusting the range they were handed,
 * because the size the caller measured and the object being read are two
 * separate reads: republishing a book replaces the object at the same key, so a
 * range worked out a moment ago can be past the end by the time it is served.
 * Null is how a provider says so — it returns no body, and the caller answers
 * 416 with the size it now knows, which is the answer that lets a client
 * correct itself.
 */
export function clampRange(range: ByteRange, size: number): ByteRange | null {
  if (size <= 0 || range.offset < 0 || range.offset >= size) return null;

  const length = Math.min(range.length, size - range.offset);
  return length > 0 ? { offset: range.offset, length } : null;
}

/** The `Content-Range` a 206 carries: which bytes these are, out of how many. */
export function contentRange(range: ByteRange, size: number): string {
  return `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
}

/**
 * The `Content-Range` a 416 carries, which names only the size — telling a
 * client that asked for the wrong bytes how long the object actually is, so its
 * next attempt can be right.
 */
export function unsatisfiedRange(size: number): string {
  return `bytes */${size}`;
}

/** Bare entity tag, with any weak marker and quotes removed. */
export function normaliseEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/"/g, "");
}

/**
 * Whether an `If-Range` validator still matches the object.
 *
 * This is the guard on a resumed download: the client says which version it
 * already holds part of, and if the object has been replaced since — which
 * republishing a book does, at the same key — then continuing from an offset
 * would splice two different files together. A mismatch means the range is
 * declined and the whole object served instead.
 */
export function ifRangeMatches(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (!header) return true;

  const value = header.trim();
  // A weak validator may not be used for a ranged request at all, since it does
  // not promise the bytes are identical. `If-Range` with a date is not
  // supported: an entity tag is what this server offers, and a client that
  // sends a date gets the whole object rather than a wrong splice.
  if (value.startsWith("W/") || !value.startsWith('"')) return false;

  return normaliseEtag(value) === normaliseEtag(etag);
}
