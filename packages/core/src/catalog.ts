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

/** The key an object inside a book's folder lives at. */
export function bookKey(id: string, file: string): string {
  return `${id}/${file}`;
}
