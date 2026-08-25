import { type Book, normaliseEtag } from "@bookshelf/core";
import { atomFeed, openSearchDocument } from "@/lib/opds/atom";
import {
  byAuthor,
  bySeries,
  bySubject,
  type Group,
  named,
} from "@/lib/opds/browse";
import {
  FORMAT_PARAM,
  feedType,
  navigationId,
  OPDS_JSON,
  OPENSEARCH,
  type OpdsFeed,
  type OpdsFormat,
  type OpdsKind,
  type OpdsLink,
  type OpdsNavigation,
  PAGE_PARAM,
  PAGE_SIZE,
  pageCount,
  QUERY_PARAM,
  updatedAt,
  urls,
} from "@/lib/opds/feed";
import { jsonFeed } from "@/lib/opds/json";
import { SITE_NAME } from "@/lib/site";
import { type Shelf, searchBooks } from "@/services/catalog";

/**
 * The catalog's URL space, and the one place that knows it.
 *
 * A single dispatch rather than a route file per feed, because the serializers
 * already have to generate every URL below in order to write their links.
 * Declaring the same space a second time in the filesystem would mean two
 * copies of it that can drift, and nine handlers each assembling a feed is more
 * code than the table below, not less.
 */

/** How long a feed is good for: the same minute the catalog memo is kept. */
const MAX_AGE_SECONDS = 60;

/** What the route hands over. Deliberately not a `Request`: see `atomFeed`. */
export type OpdsRequest = {
  /** The path segments after `/opds`, already decoded by the router. */
  path: string[];
  query: URLSearchParams;
  /** The origin this instance is reached at, for absolute links. */
  origin: URL;
  accept?: string | null;
  ifNoneMatch?: string | null;
};

/**
 * Which version the client gets.
 *
 * Negotiated from `Accept`, because that is what a client says it wants, and
 * overridable with `?format=` — which is how a link in a JSON feed keeps the
 * next request in JSON, and how any of this can be looked at with `curl`.
 */
function formatFor({ query, accept }: OpdsRequest): OpdsFormat {
  const forced = query.get(FORMAT_PARAM);
  if (forced === "json" || forced === "atom") return forced;
  return accept?.includes(OPDS_JSON) ? "json" : "atom";
}

/** A page number, or the first page for anything that is not one. */
function pageFor(query: URLSearchParams): number {
  const asked = Number(query.get(PAGE_PARAM));
  return Number.isInteger(asked) && asked > 1 ? asked : 1;
}

/**
 * The query, under either name.
 *
 * `q` is what the shelf's own search box uses, so a URL can be moved between
 * the two by hand. `query` is what OPDS 2.0 requires a templated search link to
 * name, so a 2.0 client that filled in the template sends that instead.
 */
function queryFor(query: URLSearchParams): string {
  return (query.get(QUERY_PARAM) ?? query.get("query") ?? "").trim();
}

/**
 * A weak validator over what the answer depends on.
 *
 * The body is a pure function of the catalog, the URL and the format, so there
 * is no need to hash it — which matters, because hashing it would mean building
 * every page of a large library just to answer a conditional request. A
 * KOReader that refreshes a feed it already holds gets a 304 for the cost of
 * a walk over forty characters.
 */
function etag(shelf: Shelf, request: OpdsRequest, format: OpdsFormat): string {
  const signature = [
    shelf.generatedAt ?? "",
    shelf.books.length,
    request.path.join("/"),
    request.query.toString(),
    format,
  ].join("\n");

  let hash = 0x811c9dc5;
  for (let i = 0; i < signature.length; i++) {
    hash ^= signature.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return `W/"${(hash >>> 0).toString(36)}"`;
}

type Builder = ReturnType<typeof urls>;

/** The links every feed carries, whichever feed it is. */
function common(
  { feed }: Builder,
  format: OpdsFormat,
  origin: URL,
  self: { kind: OpdsKind; href: string },
  up?: { kind: OpdsKind; href: string },
): OpdsLink[] {
  return [
    { rel: "self", href: self.href, type: feedType(self.kind, format) },
    { rel: "start", href: feed("/opds"), type: feedType("navigation", format) },
    ...(up
      ? [{ rel: "up", href: up.href, type: feedType(up.kind, format) }]
      : []),
    searchLink(format, feed, origin),
  ];
}

/**
 * How each version says a catalog can be searched.
 *
 * 1.2 points at an OpenSearch description document; 2.0 carries the URI
 * template inline and requires its keyword parameter to be called `query`,
 * which is why `/opds/books` answers to both that and `q`.
 */
function searchLink(
  format: OpdsFormat,
  feed: Builder["feed"],
  origin: URL,
): OpdsLink {
  if (format === "atom") {
    return { rel: "search", href: feed("/opds/search"), type: OPENSEARCH };
  }

  return {
    rel: "search",
    // `?format=json` first and `{&query}` after it, so the template expands to
    // a well-formed URL whether or not the client fills the parameter in.
    href: `${new URL("/opds/books", origin)}?${FORMAT_PARAM}=json{&query}`,
    type: OPDS_JSON,
    templated: true,
  };
}

/** `first`, `previous`, `next` and `last`, each only where it means something. */
function paging(
  { feed }: Builder,
  format: OpdsFormat,
  path: string,
  page: number,
  pages: number,
  query: string,
): OpdsLink[] {
  if (pages < 2) return [];
  const type = feedType("acquisition", format);
  const to = (number: number): string => feed(path, { page: number, query });

  return [
    { rel: "first", href: to(1), type },
    ...(page > 1 ? [{ rel: "previous", href: to(page - 1), type }] : []),
    ...(page < pages ? [{ rel: "next", href: to(page + 1), type }] : []),
    { rel: "last", href: to(pages), type },
  ];
}

/**
 * An acquisition feed: one page of books.
 *
 * Books with no downloadable file are dropped rather than listed, because an
 * OPDS entry must carry at least one acquisition link — an entry without one is
 * a feed a strict client rejects whole, in exchange for listing a book nobody
 * could have opened.
 */
function acquisition(
  shelf: Shelf,
  request: OpdsRequest,
  format: OpdsFormat,
  {
    path,
    title,
    books,
    up,
    query = "",
  }: {
    path: string;
    title: string;
    books: Book[];
    up?: { kind: OpdsKind; href: string };
    /** Carried into the paging links, where this feed is a search result. */
    query?: string;
  },
): OpdsFeed {
  const builder = urls(request.origin, format);
  const listed = books.filter((book) => book.formats.length > 0);
  const pages = pageCount(listed.length);
  // Clamped rather than refused: a client holding a stale page number should be
  // shown the end of the feed, not an empty one.
  const page = Math.min(pageFor(request.query), pages);
  const self = builder.feed(path, { page, query });

  return {
    kind: "acquisition",
    id: self,
    title,
    updated: updatedAt(shelf.generatedAt),
    links: [
      ...common(
        builder,
        format,
        request.origin,
        { kind: "acquisition", href: self },
        up,
      ),
      ...paging(builder, format, path, page, pages, query),
    ],
    books: listed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page: { number: page, size: PAGE_SIZE, total: listed.length },
  };
}

/** A navigation feed: a list of other feeds. */
function navigation(
  shelf: Shelf,
  request: OpdsRequest,
  format: OpdsFormat,
  {
    path,
    title,
    entries,
    up,
  }: {
    path: string;
    title: string;
    entries: OpdsNavigation[];
    up?: { kind: OpdsKind; href: string };
  },
): OpdsFeed {
  const builder = urls(request.origin, format);
  const self = builder.feed(path);

  return {
    kind: "navigation",
    id: self,
    title,
    updated: updatedAt(shelf.generatedAt),
    links: common(
      builder,
      format,
      request.origin,
      { kind: "navigation", href: self },
      up,
    ),
    navigation: entries,
  };
}

/** One navigation entry per group, pointing at that group's own feed. */
function groupEntries(
  groups: Group[],
  { feed }: Builder,
  axis: Axis,
): OpdsNavigation[] {
  // The name in the path, not a slug: it round-trips exactly, so nothing has to
  // keep a table mapping one back to the other, and two names that would slug
  // the same stay two names.
  const path = `/opds/${axis}`;

  return groups.map((group) => ({
    id: navigationId(axis, group.name),
    title: group.name,
    href: feed(`${path}/${encodeURIComponent(group.name)}`),
    kind: "acquisition",
    count: group.books.length,
  }));
}

/** The three browse axes, by their first path segment. */
const AXES = {
  authors: { group: byAuthor, title: "By author" },
  subjects: { group: bySubject, title: "By subject" },
  series: { group: bySeries, title: "By series" },
} as const;

type Axis = keyof typeof AXES;

function isAxis(segment: string | undefined): segment is Axis {
  return segment !== undefined && segment in AXES;
}

/** The root: every way into the library, and how much is behind each. */
function root(
  shelf: Shelf,
  request: OpdsRequest,
  format: OpdsFormat,
): OpdsFeed {
  const builder = urls(request.origin, format);

  const entries: OpdsNavigation[] = [
    {
      id: navigationId("books"),
      title: "All books",
      href: builder.feed("/opds/books"),
      kind: "acquisition",
      // What the feed will actually list, which is not quite every book: one
      // with no downloadable file cannot be an OPDS entry at all.
      count: shelf.books.filter((book) => book.formats.length > 0).length,
    },
  ];

  for (const axis of Object.keys(AXES) as Axis[]) {
    const count = AXES[axis].group(shelf.books).length;
    // An axis nothing is filed under is a dead end, so it is not offered. A
    // library of books with no subjects should not have a "By subject" that
    // opens on nothing.
    if (count === 0) continue;

    entries.push({
      id: navigationId(axis),
      title: AXES[axis].title,
      href: builder.feed(`/opds/${axis}`),
      kind: "navigation",
      count,
    });
  }

  return navigation(shelf, request, format, {
    path: "/opds",
    title: SITE_NAME,
    entries,
  });
}

/** The feed at a path, or null for a path this catalog does not have. */
function resolve(
  shelf: Shelf,
  request: OpdsRequest,
  format: OpdsFormat,
): OpdsFeed | null {
  const [first, second, ...rest] = request.path;
  if (rest.length > 0) return null;

  if (first === undefined) return root(shelf, request, format);

  if (first === "books") {
    if (second !== undefined) return null;
    const query = queryFor(request.query);

    return acquisition(shelf, request, format, {
      path: "/opds/books",
      // Naming the query in the title is what a client shows above the results.
      title: query ? `Books matching “${query}”` : "All books",
      books: searchBooks(shelf.books, query),
      query,
    });
  }

  if (!isAxis(first)) return null;
  const groups = AXES[first].group(shelf.books);
  const builder = urls(request.origin, format);

  if (second === undefined) {
    return navigation(shelf, request, format, {
      path: `/opds/${first}`,
      title: AXES[first].title,
      entries: groupEntries(groups, builder, first),
      up: { kind: "navigation", href: builder.feed("/opds") },
    });
  }

  const group = named(groups, second);
  if (!group) return null;

  // A query narrows whichever feed it arrives on, not only `/opds/books`: a
  // client that offers search while browsing an author sends it here, and a
  // parameter silently ignored is worse than one not offered.
  const query = queryFor(request.query);

  return acquisition(shelf, request, format, {
    path: `/opds/${first}/${encodeURIComponent(group.name)}`,
    title: query ? `${group.name} matching “${query}”` : group.name,
    books: searchBooks(group.books, query),
    up: { kind: "navigation", href: builder.feed(`/opds/${first}`) },
    query,
  });
}

/**
 * The whole catalog, as a response.
 *
 * Synchronous and pure: the shelf is read by the route and handed over, so
 * every feed this can produce is reachable from a test without a Worker context
 * or `next/headers` around it.
 */
export function serveOpds(shelf: Shelf, request: OpdsRequest): Response {
  const format = formatFor(request);

  const headers = new Headers({
    "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
    // Which version this is was negotiated from `Accept`, and the response is
    // publicly cacheable — so without this a shared cache that stored the Atom
    // one would go on handing it to clients asking for JSON, and the other way
    // round. The URL is the same for both; the request header is the whole of
    // what tells them apart.
    vary: "accept",
  });

  /**
   * Whether the client already holds this. Asked only once a path is known to
   * exist, so a validator can never turn a 404 into a 304 — and asked before
   * anything is serialized, which is the point of a validator that is derived
   * from the catalog rather than hashed out of the body.
   */
  const unchanged = (): boolean => {
    const validator = etag(shelf, request, format);
    headers.set("etag", validator);
    return (
      !!request.ifNoneMatch &&
      normaliseEtag(request.ifNoneMatch) === normaliseEtag(validator)
    );
  };

  // The one document here that is not a feed: OpenSearch has its own schema and
  // its own media type, and only 1.2 asks for it.
  if (request.path.length === 1 && request.path[0] === "search") {
    if (unchanged()) return new Response(null, { status: 304, headers });

    headers.set("content-type", `${OPENSEARCH}; charset=utf-8`);
    return new Response(openSearchDocument(request.origin), { headers });
  }

  const feed = resolve(shelf, request, format);
  if (!feed) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (unchanged()) return new Response(null, { status: 304, headers });

  headers.set("content-type", `${feedType(feed.kind, format)}; charset=utf-8`);

  return new Response(
    format === "json"
      ? jsonFeed(feed, request.origin)
      : atomFeed(feed, request.origin),
    { headers },
  );
}
