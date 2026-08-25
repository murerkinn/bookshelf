import assert from "node:assert/strict";
import { test } from "node:test";
import type { Book } from "@bookshelf/core";
import { DOMParser } from "@xmldom/xmldom";
import {
  ATOM_ACQUISITION,
  ATOM_NAVIGATION,
  OPDS_JSON,
  PAGE_SIZE,
  UNKNOWN_DATE,
} from "../src/lib/opds/feed.ts";
import { serveOpds } from "../src/lib/opds/serve.ts";
import type { Shelf } from "../src/services/catalog.ts";

/**
 * The catalog, as a client sees it.
 *
 * Everything under `lib/opds/` is a pure function of a shelf and an origin, so
 * this reaches the serializers directly rather than through the route — which
 * is the whole reason the origin is a parameter there. What that buys is the
 * assertion that matters most for hand-written XML: that it parses.
 */

const ORIGIN = new URL("https://shelf.test");
const PUBLISHED = "2026-01-02T03:04:05.000Z";

function book(id: string, title: string, rest: Partial<Book> = {}): Book {
  return {
    id,
    title,
    authors: [],
    formats: [{ format: "epub", file: `${id}.epub`, size: 4096 }],
    ...rest,
  };
}

const DRACULA = book("dracula", "Dracula", {
  authors: ["Bram Stoker"],
  publisher: "Archibald Constable & Co.",
  published: "1897",
  language: "en",
  isbn: "9780000000002",
  subjects: ["Horror", "Gothic fiction"],
  cover: "cover.webp",
  formats: [
    { format: "epub", file: "dracula.epub", size: 512_000 },
    { format: "pdf", file: "dracula.pdf", size: 2_048_000 },
  ],
});

const SHELF: Shelf = {
  generatedAt: PUBLISHED,
  books: [
    DRACULA,
    book("frankenstein", "Frankenstein", {
      authors: ["Mary Shelley"],
      subjects: ["Horror"],
      pages: 280,
    }),
    // Two volumes of one series, published out of order, plus an unnumbered
    // companion — the three cases bySeries has to get right.
    book("dune-messiah", "Dune Messiah", {
      authors: ["Frank Herbert"],
      series: "Dune",
      seriesIndex: 2,
    }),
    book("dune", "Dune", {
      authors: ["Frank Herbert"],
      series: "Dune",
      seriesIndex: 1,
    }),
    book("dune-companion", "The Dune Companion", { series: "Dune" }),
  ],
};

function get(
  shelf: Shelf,
  path: string[],
  {
    query = "",
    accept,
    ifNoneMatch,
  }: { query?: string; accept?: string; ifNoneMatch?: string } = {},
): Response {
  return serveOpds(shelf, {
    path,
    query: new URLSearchParams(query),
    origin: ORIGIN,
    accept,
    ifNoneMatch,
  });
}

/** The document, and the assertion that there was a document to have. */
async function parse(response: Response) {
  const problems: string[] = [];
  const document = new DOMParser({
    errorHandler: (level, message) => problems.push(`${level}: ${message}`),
  }).parseFromString(await response.text(), "text/xml");

  assert.deepEqual(problems, [], "the feed should parse without complaint");
  return document;
}

type Element = {
  getAttribute(name: string): string | null;
  textContent: string | null;
};

type Document = Awaited<ReturnType<typeof parse>>;

/**
 * A tag name's elements, as an array.
 *
 * xmldom's node lists are the DOM's original kind — a `length` and an `item` —
 * so they are indexed rather than spread.
 */
function elements(document: Document, name: string): Element[] {
  const nodes = document.getElementsByTagName(name);
  return Array.from(
    { length: nodes.length },
    (_, index) => nodes.item(index) as unknown as Element,
  );
}

function links(document: Document, rel: string): Element[] {
  return elements(document, "link").filter(
    (link) => link.getAttribute("rel") === rel,
  );
}

function text(document: Document, name: string): string[] {
  return elements(document, name).map((node) => node.textContent ?? "");
}

test("the root is a navigation feed that says where everything is", async () => {
  const response = get(SHELF, []);

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    `${ATOM_NAVIGATION}; charset=utf-8`,
  );

  const document = await parse(response);

  assert.equal(text(document, "updated")[0], PUBLISHED);
  assert.equal(
    links(document, "self")[0].getAttribute("href"),
    "https://shelf.test/opds",
  );
  assert.equal(
    links(document, "start")[0].getAttribute("href"),
    "https://shelf.test/opds",
  );

  const entries = links(document, "subsection");
  assert.deepEqual(
    entries.map((link) => link.getAttribute("href")),
    [
      "https://shelf.test/opds/books",
      "https://shelf.test/opds/authors",
      "https://shelf.test/opds/subjects",
      "https://shelf.test/opds/series",
    ],
  );

  // Atom requires an id to be an absolute IRI, so a navigation entry names
  // itself with a URN rather than with the path it points at.
  assert.deepEqual(text(document, "id").slice(1), [
    "urn:bookshelf:books",
    "urn:bookshelf:authors",
    "urn:bookshelf:subjects",
    "urn:bookshelf:series",
  ]);

  // All books names the whole shelf; the axes name only what is filed under
  // them, and the coverless, subjectless companion is in one and not the other.
  assert.equal(entries[0].getAttribute("thr:count"), "5");
  assert.equal(entries[1].getAttribute("thr:count"), "3");
  assert.equal(entries[2].getAttribute("thr:count"), "2");
});

test("an axis nothing is filed under is not offered", async () => {
  const document = await parse(
    get({ books: [book("plain", "A Plain Book")] }, []),
  );

  assert.deepEqual(
    links(document, "subsection").map((link) => link.getAttribute("href")),
    ["https://shelf.test/opds/books"],
  );
});

test("an unpublished catalog is an empty feed, not an error", async () => {
  const response = get({ books: [] }, ["books"]);

  assert.equal(response.status, 200);
  const document = await parse(response);

  assert.equal(elements(document, "entry").length, 0);
  // Nothing to date it by, and the epoch rather than now: an `updated` that
  // moves every request tells every client that everything changed.
  assert.equal(text(document, "updated")[0], UNKNOWN_DATE);
});

test("a book carries one acquisition link per format, with its size", async () => {
  const document = await parse(get(SHELF, ["books"]));
  const entry = elements(document, "entry");
  assert.equal(entry.length, 5);

  const acquisitions = links(
    document,
    "http://opds-spec.org/acquisition/open-access",
  ).filter((link) => link.getAttribute("href")?.includes("/dracula/"));

  assert.deepEqual(
    acquisitions.map((link) => [
      link.getAttribute("href"),
      link.getAttribute("type"),
      link.getAttribute("length"),
    ]),
    [
      [
        "https://shelf.test/download/dracula/dracula.epub",
        "application/epub+zip",
        "512000",
      ],
      [
        "https://shelf.test/download/dracula/dracula.pdf",
        "application/pdf",
        "2048000",
      ],
    ],
  );
});

test("a cover is both the image and the thumbnail it already is", async () => {
  const document = await parse(get(SHELF, ["books"]));

  for (const rel of [
    "http://opds-spec.org/image",
    "http://opds-spec.org/image/thumbnail",
  ]) {
    const [link] = links(document, rel);
    assert.equal(
      link.getAttribute("href"),
      "https://shelf.test/cover/dracula/cover.webp",
    );
    assert.equal(link.getAttribute("type"), "image/webp");
  }

  // One cover between them, so four books contribute no image links at all.
  assert.equal(links(document, "http://opds-spec.org/image").length, 1);
});

test("a book links the browser reader as an alternate, not an acquisition", async () => {
  const document = await parse(get(SHELF, ["books"]));
  const [link] = links(document, "alternate");

  assert.equal(
    link.getAttribute("href"),
    "https://shelf.test/read/dracula/dracula.epub",
  );
  assert.equal(link.getAttribute("type"), "text/html");
});

test("the reader link is the format the shelf would open, not the first", async () => {
  // The sync tool sorts a book's files, so today an EPUB precedes a PDF and
  // taking the first would look right. It is `readableFormat` that decides,
  // and this is the order that tells the two apart.
  const backwards: Shelf = {
    books: [
      book("dracula", "Dracula", {
        formats: [
          { format: "pdf", file: "dracula.pdf", size: 2_048_000 },
          { format: "epub", file: "dracula.epub", size: 512_000 },
        ],
      }),
    ],
  };

  const document = await parse(get(backwards, ["books"]));
  assert.equal(
    links(document, "alternate")[0].getAttribute("href"),
    "https://shelf.test/read/dracula/dracula.epub",
  );

  const feed = (await get(backwards, ["books"], {
    accept: OPDS_JSON,
  }).json()) as { publications: { links: { rel: string; href: string }[] }[] };
  assert.equal(
    feed.publications[0].links.find((link) => link.rel === "alternate")?.href,
    "https://shelf.test/read/dracula/dracula.epub",
  );
});

test("a book's metadata reaches the entry", async () => {
  const document = await parse(get(SHELF, ["books"]));

  assert.ok(
    text(document, "dc:publisher").includes("Archibald Constable & Co."),
  );
  assert.ok(text(document, "dc:issued").includes("1897"));
  assert.ok(text(document, "dc:language").includes("en"));
  // A checked ISBN can be named as one; anything else is only an identifier.
  assert.ok(text(document, "dc:identifier").includes("urn:isbn:9780000000002"));
  assert.ok(text(document, "dc:extent").includes("280"));
  assert.deepEqual(
    elements(document, "category")
      .map((node) => node.getAttribute("term"))
      .sort(),
    ["Gothic fiction", "Horror", "Horror"],
  );
});

test("a book with no downloadable file is not listed", async () => {
  const document = await parse(
    get({ books: [book("empty", "Nothing To Read", { formats: [] })] }, [
      "books",
    ]),
  );

  // An OPDS entry must carry an acquisition link, so an entry that could not
  // have one is left out rather than shipped as a feed a client may reject.
  assert.equal(elements(document, "entry").length, 0);
});

test("a book with no downloadable file is not counted either", async () => {
  // The same book, seen from the navigation rather than from a feed. A count
  // that included it would send a client to an author, a subject and a series
  // that each open on nothing.
  const shelf: Shelf = {
    books: [
      book("empty", "Nothing To Read", {
        formats: [],
        authors: ["Ghost Writer"],
        subjects: ["Vapourware"],
        series: "Unwritten",
      }),
    ],
  };

  const counts = (document: Document) =>
    links(document, "subsection").map((entry) =>
      entry.getAttribute("thr:count"),
    );

  // Every book is one book fewer, and all three axes are empty, so an axis
  // nothing can be filed under is not offered at all.
  assert.deepEqual(counts(await parse(get(shelf, []))), ["0"]);

  for (const axis of ["authors", "subjects", "series"]) {
    assert.deepEqual(counts(await parse(get(shelf, [axis]))), []);
    assert.equal(get(shelf, [axis, "Ghost Writer"]).status, 404);
  }
});

test("what a publisher put in a title cannot break the feed", async () => {
  const shelf: Shelf = {
    books: [
      book("odd", 'Sense & Sensibility <or> "Reason"', {
        authors: ["A & B"],
        // A form feed, which EPUB descriptions really do arrive with, and which
        // XML has no way to carry at all.
        description: "A tale of <em>two</em> houses.And an ampersand: &.",
      }),
    ],
  };

  const document = await parse(get(shelf, ["books"]));

  assert.ok(
    text(document, "title").includes('Sense & Sensibility <or> "Reason"'),
  );
  assert.ok(text(document, "name").includes("A & B"));

  // The summary is what it declares itself to be: text, with the markup gone.
  const [summary] = text(document, "summary");
  assert.equal(summary, "A tale of two houses. And an ampersand: &.");

  // The content keeps the markup, escaped, for the clients that render html.
  const [content] = text(document, "content");
  assert.equal(content, "A tale of <em>two</em> houses.And an ampersand: &.");
});

test("a long description is cut at a word", async () => {
  const shelf: Shelf = {
    books: [book("long", "Long", { description: "word ".repeat(200).trim() })],
  };

  const [summary] = text(await parse(get(shelf, ["books"])), "summary");
  assert.ok(summary.endsWith("…"));
  assert.ok(summary.length <= 501, `${summary.length} characters`);
  assert.ok(!summary.includes("wor…"));
});

test("a feed longer than a page says where the rest is", async () => {
  const many: Shelf = {
    generatedAt: PUBLISHED,
    books: Array.from({ length: PAGE_SIZE * 2 + 5 }, (_, index) =>
      book(`book-${index}`, `Book ${String(index).padStart(3, "0")}`),
    ),
  };

  const first = await parse(get(many, ["books"]));
  assert.equal(elements(first, "entry").length, PAGE_SIZE);
  assert.equal(links(first, "previous").length, 0);
  assert.equal(
    links(first, "next")[0].getAttribute("href"),
    "https://shelf.test/opds/books?page=2",
  );
  assert.equal(
    links(first, "last")[0].getAttribute("href"),
    "https://shelf.test/opds/books?page=3",
  );

  const last = await parse(get(many, ["books"], { query: "page=3" }));
  assert.equal(elements(last, "entry").length, 5);
  assert.equal(links(last, "next").length, 0);
  assert.equal(
    links(last, "previous")[0].getAttribute("href"),
    "https://shelf.test/opds/books?page=2",
  );
  // Page one is the feed itself rather than `?page=1`, so there is one URL for
  // it rather than two.
  assert.equal(
    links(last, "first")[0].getAttribute("href"),
    "https://shelf.test/opds/books",
  );

  // A stale page number is shown the end of the feed rather than nothing.
  const beyond = await parse(get(many, ["books"], { query: "page=99" }));
  assert.equal(elements(beyond, "entry").length, 5);
});

test("a feed that fits on one page has no paging links", async () => {
  const document = await parse(get(SHELF, ["books"]));

  for (const rel of ["first", "previous", "next", "last"]) {
    assert.equal(links(document, rel).length, 0, rel);
  }
});

test("an author's feed holds their books, and knows its way back", async () => {
  const listing = await parse(get(SHELF, ["authors"]));

  assert.deepEqual(
    links(listing, "subsection").map((link) => [
      link.getAttribute("href"),
      link.getAttribute("thr:count"),
    ]),
    [
      ["https://shelf.test/opds/authors/Bram%20Stoker", "1"],
      ["https://shelf.test/opds/authors/Frank%20Herbert", "2"],
      ["https://shelf.test/opds/authors/Mary%20Shelley", "1"],
    ],
  );

  assert.deepEqual(text(listing, "id").slice(1), [
    "urn:bookshelf:authors:Bram%20Stoker",
    "urn:bookshelf:authors:Frank%20Herbert",
    "urn:bookshelf:authors:Mary%20Shelley",
  ]);

  const herbert = get(SHELF, ["authors", "Frank Herbert"]);
  assert.equal(
    herbert.headers.get("content-type"),
    `${ATOM_ACQUISITION}; charset=utf-8`,
  );

  const document = await parse(herbert);
  assert.deepEqual(text(document, "title")[0], "Frank Herbert");
  assert.equal(elements(document, "entry").length, 2);
  assert.equal(
    links(document, "up")[0].getAttribute("href"),
    "https://shelf.test/opds/authors",
  );
});

test("a series reads in its own order, and an extra sorts last", async () => {
  const document = await parse(get(SHELF, ["series", "Dune"]));

  assert.deepEqual(text(document, "title").slice(1), [
    "Dune",
    "Dune Messiah",
    "The Dune Companion",
  ]);
});

test("subjects group the books that name them", async () => {
  const listing = await parse(get(SHELF, ["subjects"]));

  assert.deepEqual(
    links(listing, "subsection").map((link) => [
      link.getAttribute("href"),
      link.getAttribute("thr:count"),
    ]),
    [
      ["https://shelf.test/opds/subjects/Gothic%20fiction", "1"],
      ["https://shelf.test/opds/subjects/Horror", "2"],
    ],
  );

  const horror = await parse(get(SHELF, ["subjects", "Horror"]));
  assert.equal(elements(horror, "entry").length, 2);
});

test("search filters, under either name the two versions use", async () => {
  for (const query of ["q=dune", "query=dune"]) {
    const document = await parse(get(SHELF, ["books"], { query }));
    assert.equal(elements(document, "entry").length, 3, query);
    assert.equal(text(document, "title")[0], "Books matching “dune”");
  }

  // The query rides along in the paging links, so page two of a search is
  // still that search.
  const many: Shelf = {
    books: Array.from({ length: PAGE_SIZE + 1 }, (_, index) =>
      book(`dune-${index}`, `Dune ${index}`),
    ),
  };
  const document = await parse(get(many, ["books"], { query: "q=dune" }));
  assert.equal(
    links(document, "next")[0].getAttribute("href"),
    "https://shelf.test/opds/books?q=dune&page=2",
  );
});

test("a query narrows whichever book feed it arrives on", async () => {
  const document = await parse(
    get(SHELF, ["authors", "Frank Herbert"], { query: "q=messiah" }),
  );

  assert.deepEqual(text(document, "title"), [
    "Frank Herbert matching “messiah”",
    "Dune Messiah",
  ]);

  // And rides the paging links from there, the same as it does on /opds/books.
  const many: Shelf = {
    books: Array.from({ length: PAGE_SIZE + 1 }, (_, index) =>
      book(`dune-${index}`, `Dune ${index}`, { authors: ["Frank Herbert"] }),
    ),
  };
  assert.equal(
    links(
      await parse(get(many, ["authors", "Frank Herbert"], { query: "q=dune" })),
      "next",
    )[0].getAttribute("href"),
    "https://shelf.test/opds/authors/Frank%20Herbert?q=dune&page=2",
  );
});

test("a query nothing matches is an empty feed rather than a 404", async () => {
  const response = get(SHELF, ["books"], { query: "q=nothing here" });

  assert.equal(response.status, 200);
  assert.equal(elements(await parse(response), "entry").length, 0);
});

test("the catalog says how it can be searched", async () => {
  const document = await parse(get(SHELF, []));
  const [search] = links(document, "search");

  assert.equal(
    search.getAttribute("type"),
    "application/opensearchdescription+xml",
  );
  assert.equal(search.getAttribute("href"), "https://shelf.test/opds/search");
});

test("the OpenSearch document keeps its template intact", async () => {
  const response = get(SHELF, ["search"]);

  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/opensearchdescription\+xml/,
  );

  const document = await parse(response);
  const templates = elements(document, "Url").map((url) => [
    url.getAttribute("type"),
    url.getAttribute("template"),
  ]);

  // Braces, not %7B: a percent-encoded placeholder parses and then never
  // substitutes anything.
  assert.deepEqual(templates, [
    [ATOM_ACQUISITION, "https://shelf.test/opds/books?q={searchTerms}"],
    [OPDS_JSON, "https://shelf.test/opds/books?q={searchTerms}&format=json"],
  ]);
});

test("a path this catalog does not have is a 404", async () => {
  for (const path of [
    ["nonsense"],
    ["books", "extra"],
    ["authors", "Nobody At All"],
    ["authors", "Bram Stoker", "deeper"],
  ]) {
    assert.equal(get(SHELF, path).status, 404, path.join("/"));
  }
});

test("a client that already holds a feed is told so", async () => {
  const etag = get(SHELF, ["books"]).headers.get("etag");
  assert.match(etag ?? "", /^W\//);

  const again = get(SHELF, ["books"], { ifNoneMatch: etag ?? "" });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");

  // The validator covers the URL as well as the catalog, so another page of the
  // same feed is not mistaken for this one.
  const second = get(SHELF, ["books"], { query: "page=2" });
  assert.notEqual(second.headers.get("etag"), etag);

  // And a republished library invalidates it.
  const republished = get(
    { ...SHELF, generatedAt: "2026-06-01T00:00:00.000Z" },
    ["books"],
  );
  assert.notEqual(republished.headers.get("etag"), etag);
});

test("a validator never turns a missing feed into an unchanged one", async () => {
  // The validator covers the path, so a client cannot hold one for a path that
  // does not exist — but a 404 must not carry one either, or a stale validator
  // could be answered 304 by a feed that was never there.
  const missing = get(SHELF, ["authors", "Nobody At All"], {
    ifNoneMatch: get(SHELF, ["books"]).headers.get("etag") ?? "",
  });

  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("etag"), null);
});

test("the OpenSearch document is validated too", async () => {
  const etag = get(SHELF, ["search"]).headers.get("etag");
  assert.equal(get(SHELF, ["search"], { ifNoneMatch: etag ?? "" }).status, 304);
});

test("a feed is good for the minute the catalog memo is", async () => {
  assert.equal(
    get(SHELF, []).headers.get("cache-control"),
    "public, max-age=60",
  );
});

test("a cacheable feed says what it was negotiated on", async () => {
  // The URL is the same for both versions and the response is public, so a
  // shared cache needs telling that `Accept` is what separates them.
  for (const response of [
    get(SHELF, []),
    get(SHELF, [], { accept: OPDS_JSON }),
    get(SHELF, ["search"]),
    get(SHELF, [], { ifNoneMatch: get(SHELF, []).headers.get("etag") ?? "" }),
  ]) {
    assert.equal(response.headers.get("vary"), "accept");
  }
});

test("OPDS 2.0 is the same catalog as JSON", async () => {
  const response = get(SHELF, ["books"], { accept: OPDS_JSON });
  assert.equal(
    response.headers.get("content-type"),
    `${OPDS_JSON}; charset=utf-8`,
  );

  const feed = (await response.json()) as {
    metadata: Record<string, unknown>;
    links: { rel: string; href: string; templated?: boolean }[];
    publications: {
      metadata: Record<string, unknown>;
      links: { rel: string; href: string }[];
      images?: { href: string }[];
    }[];
  };

  assert.deepEqual(feed.metadata, {
    title: "All books",
    modified: PUBLISHED,
    numberOfItems: 5,
    itemsPerPage: PAGE_SIZE,
    currentPage: 1,
  });
  assert.equal(feed.publications.length, 5);

  const dracula = feed.publications[0];
  assert.deepEqual(dracula.metadata, {
    "@type": "http://schema.org/EBook",
    identifier: "urn:isbn:9780000000002",
    title: "Dracula",
    author: "Bram Stoker",
    language: "en",
    publisher: "Archibald Constable & Co.",
    published: "1897",
    modified: PUBLISHED,
    subject: ["Horror", "Gothic fiction"],
  });

  // Several authors are an array where one is a string, which is the model this
  // version borrows from Readium.
  const dune = feed.publications.find((p) => p.metadata.title === "Dune");
  assert.deepEqual(dune?.metadata.belongsTo, {
    series: { name: "Dune", position: 1 },
  });

  assert.equal(
    dracula.links[0].href,
    "https://shelf.test/download/dracula/dracula.epub",
  );
  assert.equal(
    dracula.images?.[0].href,
    "https://shelf.test/cover/dracula/cover.webp",
  );
});

test("a JSON feed keeps a client in JSON", async () => {
  const feed = (await get(SHELF, [], { accept: OPDS_JSON }).json()) as {
    links: { rel: string; href: string; templated?: boolean }[];
    navigation: { href: string }[];
  };

  // Every link to another feed is stamped, so the next request stays in this
  // version whatever the client puts in its Accept header.
  for (const { href } of feed.navigation) {
    assert.match(href, /format=json/, href);
  }
  assert.match(
    feed.links.find((link) => link.rel === "self")?.href ?? "",
    /format=json/,
  );

  // 2.0 carries the search template inline rather than pointing at an
  // OpenSearch document, and names its parameter `query`.
  const search = feed.links.find((link) => link.rel === "search");
  assert.equal(search?.templated, true);
  assert.equal(
    search?.href,
    "https://shelf.test/opds/books?format=json{&query}",
  );
});

test("a download link is never stamped with a format", async () => {
  const feed = (await get(SHELF, ["books"], { accept: OPDS_JSON }).json()) as {
    publications: { links: { href: string }[]; images?: { href: string }[] }[];
  };

  for (const publication of feed.publications) {
    for (const { href } of [
      ...publication.links,
      ...(publication.images ?? []),
    ]) {
      assert.doesNotMatch(href, /format=json/, href);
    }
  }
});

test("?format wins over what a client asked for", async () => {
  assert.match(
    get(SHELF, [], { query: "format=json" }).headers.get("content-type") ?? "",
    /opds\+json/,
  );
  assert.match(
    get(SHELF, [], { query: "format=atom", accept: OPDS_JSON }).headers.get(
      "content-type",
    ) ?? "",
    /atom\+xml/,
  );
});
