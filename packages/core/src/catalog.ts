/**
 * The contract between the sync tool and the app: what a published library
 * looks like on disk, and what the app may assume about it. It lives here
 * because both sides have to agree, and previously each declared its own copy.
 */

/** Bumped when the shape below changes incompatibly. */
export const CATALOG_VERSION = 1;

/** The catalog, at the root of the library. */
export const CATALOG_FILE = "catalog.json";

/** A book's own metadata, inside its folder. */
export const METADATA_FILE = "metadata.json";

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
  /**
   * ISBN-13 or ISBN-10, digits only, and only when its check digit was valid —
   * an identifier field holds whatever the publisher put there, so a number
   * that has not been verified is not recorded as an ISBN.
   */
  isbn?: string;
  description?: string;
  /** Subjects or tags, as the book records them. */
  subjects?: string[];
  /** The series this book belongs to, and its place in it. */
  series?: string;
  seriesIndex?: number;
  /**
   * Pages, for a format that has a fixed page count. A PDF does; an EPUB
   * reflows and so has none, which is why this is optional rather than a field
   * every book carries.
   */
  pages?: number;
  /** Cover file name within the folder; absent when the book has none. */
  cover?: string;
  formats: BookFormat[];
};

export type Catalog = {
  version: number;
  generatedAt?: string;
  books: Book[];
};

/** The key an object inside a book's folder lives at. */
export function bookKey(id: string, file: string): string {
  return `${id}/${file}`;
}

/**
 * A key that addresses a file inside a book's folder, split into its two
 * halves — or null for anything else.
 *
 * The inverse of {@link bookKey}, and the only shape of key a request is
 * allowed to name. Every URL the shelf builds is a `bookKey`, so a key that is
 * not one was not built here: the catalog, anything under the app's own
 * reserved prefix, and any object that happens to share the bucket.
 *
 * By shape rather than against the catalog on purpose. A byte route that had to
 * resolve a key through the catalog would stop serving books the moment the
 * catalog could not be read or could not be parsed — an empty catalog is a
 * legitimate answer for an unpublished library, and it would turn every
 * download into a 404. This costs no read and cannot fail open.
 */
export function parseBookKey(key: string): { id: string; file: string } | null {
  const slash = key.indexOf("/");
  if (slash === -1) return null;

  const id = key.slice(0, slash);
  const file = key.slice(slash + 1);

  // An id is a slug, so it leads with an alphanumeric and cannot be a dotted
  // name. A file sits directly in the folder, so it holds no slash — which is
  // what keeps `progress/<profile>.json` from being reachable as a file — and
  // cannot lead with a dot, which is what rules out `.` and `..`.
  if (!/^[a-z0-9][a-z0-9-]{0,95}$/.test(id)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file)) return null;

  return { id, file };
}
