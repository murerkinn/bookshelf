# The OPDS catalog

The library, as something other readers can browse. Point KOReader, Thorium,
Calibre, Panels, Moon+ Reader or Aldiko at `/opds` and the shelf becomes a
catalog they can search and download from — which matters most on e-ink
hardware, where the reader on the device is better than a browser can be.

```
http://your-shelf.example/opds
```

That is the whole of the setup. There is nothing to enable and nothing to
configure.

## What is served

`/opds` is a navigation feed: a list of the ways into the library, each with a
count of what is behind it.

```
/opds                        the root
/opds/books                  every book, 50 to a page
/opds/authors                one entry per author
/opds/authors/<name>         that author's books
/opds/subjects               one entry per subject
/opds/subjects/<name>
/opds/series                 one entry per series
/opds/series/<name>          in reading order
/opds/search                 the OpenSearch description document
```

An axis nothing is filed under is not offered, so a library of books that record
no subjects has no **By subject** to open on nothing.

Names in a path are the author, subject or series percent-encoded rather than
slugged — `/opds/authors/Arthur%20Conan%20Doyle`. A name round-trips exactly, so
nothing has to keep a table mapping a slug back to a name, and two authors whose
names would slug the same stay two authors.

### Searching

`?q=` on any book feed, which is the same parameter the shelf's own search box
uses, so a URL can be carried between the two by hand. `?query=` works too:
OPDS 2.0 requires a templated search link to name its parameter that.

The query rides along in the paging links, so page two of a search is still that
search.

### Paging

Fifty books to a page, `?page=2` onwards, with `first`, `previous`, `next` and
`last` links where each of those means something. Page one is the feed itself
rather than `?page=1`, so there is one URL for it rather than two. A client
holding a stale page number is shown the end of the feed rather than an empty
one.

## Two versions

| | |
| --- | --- |
| **OPDS 1.2** | Atom XML. The default, and what every client speaks. |
| **OPDS 2.0** | JSON. For Thorium and other newer clients. |

Which one a request gets is negotiated from its `Accept` header — ask for
`application/opds+json` and the same URL answers 2.0. `?format=json` and
`?format=atom` force it either way, which is how to look at both with `curl`:

```bash
curl -s http://localhost:3000/opds | xmllint --format -
curl -s -H 'accept: application/opds+json' http://localhost:3000/opds | jq
```

When 2.0 is served, every link to another feed carries `format=json`. Without
that, a client that reached a JSON feed and then sent a wildcard `Accept` on its
next request would be handed Atom halfway through browsing. Links to a book, a
cover or the reader are never stamped: those routes have one representation.

## What a book carries

Everything the sync tool read out of the book itself — there is no second source
of metadata and nothing is inferred from a file name.

- **One acquisition link per format**, with its media type and its size in
  bytes, so a client shows how big a download is before starting it. The
  relation is `http://opds-spec.org/acquisition/open-access`: freely
  downloadable, no payment and no authentication.
- **The cover**, as both `image` and `image/thumbnail`. Those point at the same
  object because a published cover already *is* a 240px thumbnail.
- **An `alternate` link to the browser reader**, for a client that would rather
  hand a book to a browser than download it.
- Authors, publisher, publication date, language, subjects as categories, page
  count for a format that has one, and an identifier — named as an ISBN only
  when the sync tool checked its digit.
- The series, as Calibre's `calibre:series` extension. Not part of OPDS, but it
  is what Calibre and Calibre-Web read, and a client that has not heard of it
  ignores it.

A book with no downloadable file is left out rather than listed: an OPDS entry
must carry at least one acquisition link, and an entry without one is a feed a
strict client rejects whole.

Two things worth knowing about how far the metadata goes:

- **Covers are WebP by default** (see [publishing](publishing.md#covers)), and
  OPDS 1.2 recommends GIF, JPEG or PNG. Thorium and Panels render WebP;
  KOReader's OPDS browser is text-only, so it never asks. The link carries the
  cover's true content type either way.
- **Every book is dated by when the catalog was published**, because that is the
  only timestamp a library has — nothing records when an individual book was
  added. Harmless here, since OPDS clients re-list rather than diff, and the
  reason there is no **Recently added**.

## Adding it to a reader

**KOReader** — the one this is for. `≡` → *OPDS catalog* → `+` → the URL above.
Browse to a book and it downloads to the device.

**Thorium Reader** — *Catalogs* → *Add catalog*, then the URL. The quickest way
to see the feed with covers, and it speaks both versions.

**Calibre** — *Get books* → *Search* → add a store by OPDS URL.

**Panels**, **Moon+ Reader**, **Aldiko**, **Chunky** — each has an "add OPDS
catalog" field somewhere in its settings. All of them speak 1.2.

## There is no authentication

The catalog is open to anyone who can reach it, exactly like the rest of the
app: `/download/` already serves every book with no credential, and the profile
cookie names a profile rather than proving anything about who holds it.

What the feed adds is not access but *enumeration*. Before it, walking the whole
library meant scraping HTML; now there is a stable, well-known URL that lists
every book and every download link in a form built for machines. Nothing new is
reachable, and it is a great deal easier to reach all of it.

So the advice is the same as the README's, and it matters a little more: put an
instance on a network you trust, or behind something that asks who is calling.
Authentication is [roadmap #4](roadmap.md), and it is the thing OPDS most wants
next — clients do HTTP Basic rather than an identity provider, which is why that
entry points at scoped tokens.

`/opds` is disallowed in `robots.txt`, for the same reason `/download/` is. That
keeps crawlers off it; it is not a security measure and is not meant as one.

## Caching

A feed carries `public, max-age=60`, the same minute the catalog memo is kept
for, and a weak ETag. The body is a pure function of the catalog, the URL and
the format, so the validator is derived from those rather than by hashing the
response — which means a client refreshing a feed it already holds gets a 304
without the server building the feed to find out.

A library that cannot be read answers `503` with `Retry-After` rather than an
empty catalog. A client told 404 stops asking; one told 503 comes back, and an
OPDS client that cached an empty library would show an empty library.

## Where the code is

```
apps/bookshelf/src/app/opds/[[...path]]/route.ts   the whole route
apps/bookshelf/src/lib/opds/
  feed.ts        the model, the media types, the relations, the URL builder
  browse.ts      the groupings: by author, by subject, by series
  xml.ts         escaping, and the characters XML cannot carry at all
  atom.ts        OPDS 1.2, and the OpenSearch document
  json.ts        OPDS 2.0
  serve.ts       the URL space, format negotiation, and the response
```

One route rather than nine, because the serializers already have to generate
every URL above in order to write their links: a second copy of the URL space in
the filesystem is a second copy that can drift.

Nothing under `lib/opds/` reads `next/headers` — the origin arrives as a
parameter, and `serveOpds` takes the shelf it is serving. That is what makes the
whole of it reachable from `apps/bookshelf/test/opds.test.ts`, where every feed
is parsed rather than pattern-matched, because the assertion that matters most
for hand-written XML is that it parses at all.
