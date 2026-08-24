import type { Book } from "@bookshelf/core";

/**
 * The model both wire formats are written from.
 *
 * Shaped after OPDS 2.0 — a feed is metadata, links, and either navigation or
 * publications — because that is the more general of the two and makes the JSON
 * serializer nearly a `JSON.stringify`. Atom is then the one translation step
 * rather than a second model.
 */

/** OPDS 1.2 is Atom; OPDS 2.0 is JSON. One catalog serves both. */
export type OpdsFormat = "atom" | "json";

/**
 * Which of the two kinds of feed this is. It decides the media type, and in
 * Atom the media type is the only thing that says which — an acquisition feed
 * and a navigation feed are both `<feed>`.
 */
export type OpdsKind = "navigation" | "acquisition";

export const ATOM_NAVIGATION =
  "application/atom+xml;profile=opds-catalog;kind=navigation";
export const ATOM_ACQUISITION =
  "application/atom+xml;profile=opds-catalog;kind=acquisition";
export const OPDS_JSON = "application/opds+json";
export const OPENSEARCH = "application/opensearchdescription+xml";

/**
 * Freely downloadable, no payment and no authentication. The generic
 * `.../acquisition` would also be read by every client, but this one says
 * something true that the generic one leaves open.
 *
 * OPDS 2.0 permits a short alias (`download`) for the same relation. The URI is
 * compliant in both versions, so both serializers use it and the projection
 * from a book to its links is written once.
 */
export const ACQUISITION = "http://opds-spec.org/acquisition/open-access";
export const IMAGE = "http://opds-spec.org/image";
export const THUMBNAIL = "http://opds-spec.org/image/thumbnail";

/**
 * The catalog as an entry for a page's `alternates.types`, so a client looking
 * for one finds it in the shelf's own `<head>`.
 *
 * A constant rather than a literal per page, because Next replaces a child's
 * `alternates` with its own outright instead of merging into it — the same trap
 * `OG_BASE` exists for. Any page that sets a canonical has to repeat this or
 * silently lose it.
 */
export const OPDS_ALTERNATE = { [ATOM_NAVIGATION]: "/opds" } as const;

/** How many books a feed carries before it pages. */
export const PAGE_SIZE = 50;

/** Chosen by a client, or forced with `?format=`. */
export const FORMAT_PARAM = "format";

/** What the shelf's own search box calls it, so the two agree. */
export const QUERY_PARAM = "q";

/** One-based, so `?page=2` is the second page and page one has no parameter. */
export const PAGE_PARAM = "page";

export type OpdsLink = {
  rel: string;
  href: string;
  type: string;
  title?: string;
  /** Bytes, on an acquisition link — what a client shows before downloading. */
  length?: number;
  /** How many publications lie behind a navigation link. */
  count?: number;
  /** A URI template rather than a URL, for search. */
  templated?: boolean;
};

/** One entry in a navigation feed: somewhere else to go, and how big it is. */
export type OpdsNavigation = {
  /** Stable across origins, so a client can recognise it again. */
  id: string;
  title: string;
  href: string;
  /** What is on the other side — `/opds/authors` is another list of lists. */
  kind: OpdsKind;
  count?: number;
};

/** Where in a paged feed this page falls. */
export type OpdsPage = { number: number; size: number; total: number };

export type OpdsFeed = {
  kind: OpdsKind;
  /** The feed's own IRI, which is also its self link. */
  id: string;
  title: string;
  /** RFC 3339. Atom requires it on the feed and on every entry. */
  updated: string;
  links: OpdsLink[];
  navigation?: OpdsNavigation[];
  books?: Book[];
  page?: OpdsPage;
};

/**
 * The one timestamp a library has is the date its catalog was published, and a
 * catalog written before that field existed does not carry even that.
 *
 * The epoch stands in, rather than the current time: a feed whose `updated`
 * moves on every request tells every client that everything changed on every
 * request, which is worse than admitting the date is unknown.
 */
export const UNKNOWN_DATE = "1970-01-01T00:00:00Z";

export function updatedAt(generatedAt: string | undefined): string {
  if (!generatedAt) return UNKNOWN_DATE;
  const parsed = new Date(generatedAt);
  return Number.isNaN(parsed.getTime()) ? UNKNOWN_DATE : parsed.toISOString();
}

export function feedType(kind: OpdsKind, format: OpdsFormat): string {
  if (format === "json") return OPDS_JSON;
  return kind === "navigation" ? ATOM_NAVIGATION : ATOM_ACQUISITION;
}

/**
 * A book's identity in a feed.
 *
 * A URN rather than its URL, because an Atom id names the thing and not where
 * it was found: the same book served from a laptop and from a Worker is one
 * book, and a client that has downloaded it should know that.
 */
export function bookId(id: string): string {
  return `urn:bookshelf:book:${id}`;
}

/**
 * A navigation entry's identity, for the same reason and with the same shape.
 *
 * A URN rather than the path it points at, because Atom requires an id to be an
 * absolute IRI and `/opds/authors` is neither absolute nor an IRI. `name` is
 * percent-encoded, since a URN has no room for a space.
 */
export function navigationId(axis: string, name?: string): string {
  return name === undefined
    ? `urn:bookshelf:${axis}`
    : `urn:bookshelf:${axis}:${encodeURIComponent(name)}`;
}

/** Every page a total splits into, at least one even when there are no books. */
export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * How a feed writes its own URLs.
 *
 * Absolute, because OPDS clients resolve relative hrefs inconsistently and
 * several do not resolve them at all.
 *
 * Two builders rather than one, and the difference matters. A link to another
 * feed is stamped with the format: which one a client gets is negotiated from
 * its `Accept` header, so one that reached a JSON feed and then sent a wildcard
 * Accept would otherwise be handed Atom halfway through browsing. A link to a
 * book, a cover or the reader is never stamped, because those routes have one
 * representation and would only be handed a parameter to ignore.
 */
export function urls(origin: URL, format: OpdsFormat) {
  const absolute = (
    path: string,
    query: Record<string, string | number | undefined>,
  ): URL => {
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url;
  };

  return {
    /** Something the app serves one way: a download, a cover, the reader. */
    asset: (path: string): string => absolute(path, {}).toString(),

    /** Another feed under `/opds`, with its page and query carried along. */
    feed: (
      path: string,
      { page, query }: { page?: number; query?: string } = {},
    ): string => {
      const url = absolute(path, {
        [QUERY_PARAM]: query,
        // Page one is the feed itself; naming it would make two URLs for it.
        [PAGE_PARAM]: page && page > 1 ? page : undefined,
      });
      if (format === "json") url.searchParams.set(FORMAT_PARAM, "json");
      return url.toString();
    },
  };
}
