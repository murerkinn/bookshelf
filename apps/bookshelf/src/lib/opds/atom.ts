import { type Book, bookKey, contentTypeFor } from "@bookshelf/core";
import { encodeKey } from "@/lib/http";
import { imageContentType } from "@/lib/media";
import {
  ACQUISITION,
  ATOM_ACQUISITION,
  bookId,
  feedType,
  IMAGE,
  OPDS_JSON,
  type OpdsFeed,
  type OpdsLink,
  type OpdsNavigation,
  THUMBNAIL,
  urls,
} from "@/lib/opds/feed";
import { attribute, element, escapeXml, plainText } from "@/lib/opds/xml";
import { SITE_NAME } from "@/lib/site";

/**
 * OPDS 1.2: an Atom feed with a profile on its media type.
 *
 * This is the version every client speaks — KOReader, Calibre, Moon+ Reader,
 * Panels, Aldiko — and it is written by hand rather than through a library
 * because the whole of it is the file below, while a dependency that had to run
 * in workerd would have been the larger commitment.
 */

const NAMESPACES = [
  'xmlns="http://www.w3.org/2005/Atom"',
  'xmlns:dc="http://purl.org/dc/terms/"',
  'xmlns:opds="http://opds-spec.org/2010/catalog"',
  // For thr:count on a navigation link, below.
  'xmlns:thr="http://purl.org/syndication/thread/1.0"',
  // Calibre's series extension. Not part of OPDS, but it is what Calibre and
  // Calibre-Web read, and a client that has not heard of it ignores it.
  'xmlns:calibre="http://calibre.kovidgoyal.net/2009/metadata"',
].join("\n      ");

function link({ rel, href, type, title, length, count, templated }: OpdsLink) {
  return [
    "<link",
    attribute("rel", rel),
    attribute("href", href),
    attribute("type", type),
    attribute("title", title),
    attribute("length", length),
    attribute("thr:count", count),
    templated ? ' opds:templated="true"' : "",
    "/>",
  ].join("");
}

/**
 * A navigation entry: somewhere else to go, with a count of what is there.
 *
 * `subsection` is the relation OPDS catalogs use for this. The count is
 * `thr:count`, which the specification defines for facets rather than for
 * navigation — Calibre-Web and Komga both put it here anyway, KOReader shows
 * it, and a client that has never heard of the attribute drops it.
 */
function navigationEntry(entry: OpdsNavigation, updated: string): string {
  return [
    "<entry>",
    element("id", entry.id),
    element("title", entry.title),
    element("updated", updated),
    link({
      rel: "subsection",
      href: entry.href,
      type: feedType(entry.kind, "atom"),
      count: entry.count,
    }),
    "</entry>",
  ].join("");
}

/** Everything a book contributes to an entry that is not one of its links. */
function bookMetadata(book: Book, updated: string): string {
  return [
    element("id", bookId(book.id)),
    element("title", book.title),
    element("updated", updated),
    ...book.authors.map((name) => `<author>${element("name", name)}</author>`),
    element("dc:language", book.language),
    element("dc:publisher", book.publisher),
    element("dc:issued", book.published),
    // Whatever the publisher put in the book, unless it was a valid ISBN — in
    // which case the sync tool checked its digit and it can be named as one.
    element(
      "dc:identifier",
      book.isbn ? `urn:isbn:${book.isbn}` : book.identifier,
    ),
    element("dc:extent", book.pages),
    element("calibre:series", book.series),
    element("calibre:series_index", book.seriesIndex),
    ...(book.subjects ?? []).map(
      (subject) =>
        `<category${attribute("term", subject)}${attribute("label", subject)}/>`,
    ),
    // Both, because clients differ on which they show and a description that is
    // HTML — which most are — is only honest as one of the two.
    ...(book.description
      ? [
          element("summary", plainText(book.description), ' type="text"'),
          `<content type="html">${escapeXml(book.description)}</content>`,
        ]
      : []),
  ].join("");
}

/** Every way a book can be reached: its files, its cover, and the reader. */
function bookLinks(book: Book, asset: (path: string) => string): string {
  const cover = book.cover
    ? `/cover/${encodeKey(bookKey(book.id, book.cover))}`
    : undefined;

  return [
    ...book.formats.map((format) =>
      link({
        rel: ACQUISITION,
        href: asset(`/download/${encodeKey(bookKey(book.id, format.file))}`),
        type: contentTypeFor(format.file),
        length: format.size,
      }),
    ),
    // The published cover is already a 240px thumbnail, so it is genuinely both
    // of these rather than one standing in for the other.
    ...(cover
      ? [IMAGE, THUMBNAIL].map((rel) =>
          link({ rel, href: asset(cover), type: imageContentType(cover) }),
        )
      : []),
    // Not an acquisition: a client that would rather hand a book to a browser
    // than download it can, and the browser reader keeps a reading position.
    ...(book.formats.length > 0
      ? [
          link({
            rel: "alternate",
            href: asset(
              `/read/${encodeKey(bookKey(book.id, book.formats[0].file))}`,
            ),
            type: "text/html",
            title: "Read in the browser",
          }),
        ]
      : []),
  ].join("");
}

/**
 * The feed, as one string.
 *
 * The origin is a parameter rather than something read from the request, which
 * is what keeps this testable: everything under `lib/opds/` is a pure function
 * of a catalog and a URL, and none of it reaches for `next/headers`.
 */
export function atomFeed(feed: OpdsFeed, origin: URL): string {
  const { asset } = urls(origin, "atom");

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<feed ${NAMESPACES}>`,
    element("id", feed.id),
    element("title", feed.title),
    element("updated", feed.updated),
    // RFC 4287 wants an author on the feed, and a self-hosted library has
    // exactly one thing to say about who published it.
    `<author>${element("name", SITE_NAME)}</author>`,
    ...feed.links.map(link),
    ...(feed.navigation ?? []).map((entry) =>
      navigationEntry(entry, feed.updated),
    ),
    ...(feed.books ?? []).map(
      (book) =>
        `<entry>${bookMetadata(book, feed.updated)}${bookLinks(book, asset)}</entry>`,
    ),
    "</feed>",
    "",
  ].join("\n");
}

/**
 * The OpenSearch description document a catalog points at with `rel="search"`.
 *
 * Built by concatenation rather than through `URLSearchParams`, because the
 * template has to reach the client with its braces intact — percent-encoding
 * `{searchTerms}` produces a document that parses and a search that never
 * substitutes anything.
 */
export function openSearchDocument(origin: URL): string {
  const template = `${new URL("/opds/books", origin)}?q={searchTerms}`;

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">',
    element("ShortName", SITE_NAME),
    element("Description", `Search the ${SITE_NAME} library.`),
    element("InputEncoding", "UTF-8"),
    element("OutputEncoding", "UTF-8"),
    `<Url${attribute("type", ATOM_ACQUISITION)}${attribute("template", template)}/>`,
    `<Url${attribute("type", OPDS_JSON)}${attribute("template", `${template}&format=json`)}/>`,
    "</OpenSearchDescription>",
    "",
  ].join("\n");
}
