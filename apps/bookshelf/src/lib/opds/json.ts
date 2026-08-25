import { type Book, bookKey, contentTypeFor } from "@bookshelf/core";
import { encodeKey } from "@/lib/http";
import { imageContentType } from "@/lib/media";
import {
  ACQUISITION,
  bookId,
  feedType,
  type OpdsFeed,
  type OpdsLink,
  urls,
} from "@/lib/opds/feed";
import { readableFormat } from "@/services/catalog";

/**
 * OPDS 2.0: the same catalog as JSON.
 *
 * A second serializer rather than a second model — `OpdsFeed` is shaped after
 * this version, so most of this file is dropping the fields a book does not
 * have. The specification is explicit that a metadata object should carry no
 * blank values, and a client reading `"publisher": ""` would render an empty
 * line where a book simply has no publisher.
 *
 * Both versions use the same `http://opds-spec.org/acquisition/*` relations.
 * 2.0 also permits short aliases for them, but the URIs are valid in both, so
 * the projection from a book to its links is written once.
 */

/** Drops every key whose value is absent, one level deep. */
function present<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, held]) =>
        held !== undefined &&
        held !== "" &&
        !(Array.isArray(held) && held.length === 0),
    ),
  ) as Partial<T>;
}

function jsonLink({ rel, href, type, title, count, templated }: OpdsLink) {
  return present({
    rel,
    href,
    type,
    title,
    templated: templated ? true : undefined,
    properties: count === undefined ? undefined : { numberOfItems: count },
  });
}

function publication(
  book: Book,
  updated: string,
  origin: URL,
): Record<string, unknown> {
  const { asset } = urls(origin, "json");
  const cover = book.cover
    ? `/cover/${encodeKey(bookKey(book.id, book.cover))}`
    : undefined;
  const readable = readableFormat(book);

  return present({
    metadata: present({
      "@type": "http://schema.org/EBook",
      identifier: book.isbn ? `urn:isbn:${book.isbn}` : bookId(book.id),
      title: book.title,
      // A single author is a string and several are an array, which is what the
      // Readium manifest model this version borrows expects.
      author: book.authors.length === 1 ? book.authors[0] : book.authors,
      language: book.language,
      publisher: book.publisher,
      published: book.published,
      modified: updated,
      subject: book.subjects,
      description: book.description,
      numberOfPages: book.pages,
      belongsTo: book.series
        ? { series: present({ name: book.series, position: book.seriesIndex }) }
        : undefined,
    }),
    links: [
      ...book.formats.map((format) =>
        jsonLink({
          rel: ACQUISITION,
          href: asset(`/download/${encodeKey(bookKey(book.id, format.file))}`),
          type: contentTypeFor(format.file),
        }),
      ),
      // The format the shelf's own Read button opens, through the same helper.
      ...(readable
        ? [
            jsonLink({
              rel: "alternate",
              href: asset(
                `/read/${encodeKey(bookKey(book.id, readable.file))}`,
              ),
              type: "text/html",
              title: "Read in the browser",
            }),
          ]
        : []),
    ],
    images: cover
      ? [{ href: asset(cover), type: imageContentType(cover) }]
      : undefined,
  });
}

/**
 * The feed as a JSON string.
 *
 * Pagination lives in `metadata` here rather than only in the links, which is
 * the one thing 2.0 does better than Atom: a client can show "page 2 of 9"
 * without having to count what it was sent.
 */
export function jsonFeed(feed: OpdsFeed, origin: URL): string {
  return JSON.stringify(
    present({
      metadata: present({
        title: feed.title,
        modified: feed.updated,
        numberOfItems: feed.page?.total,
        itemsPerPage: feed.page?.size,
        currentPage: feed.page?.number,
      }),
      links: feed.links.map(jsonLink),
      navigation: (feed.navigation ?? []).map((entry) =>
        jsonLink({
          rel: "subsection",
          href: entry.href,
          type: feedType(entry.kind, "json"),
          title: entry.title,
          count: entry.count,
        }),
      ),
      publications: (feed.books ?? []).map((book) =>
        publication(book, feed.updated, origin),
      ),
    }),
  );
}
