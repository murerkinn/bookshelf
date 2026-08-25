# The OPDS catalog

Your library, in the format e-readers browse. Point KOReader on a Kobo — or
Thorium, Calibre, Panels, Moon+ Reader or Aldiko — at your shelf and it can
search and download from it directly.

```
http://your-shelf.example/opds
```

That's the whole setup. There's nothing to enable and nothing to configure.

## Adding it to your reader

**KOReader** — `≡` → *OPDS catalog* → `+`, then the URL. Browse to a book and it
downloads to the device.

**Thorium Reader** — *Catalogs* → *Add catalog*, then the URL. The quickest way
to see your feed with covers.

**Calibre** — *Get books* → *Search* → add a store by OPDS URL.

**Panels**, **Moon+ Reader**, **Aldiko**, **Chunky** — each has an "add OPDS
catalog" field in its settings.

## What you can browse

```
/opds                    the root
/opds/books              every book, 50 to a page
/opds/authors            one entry per author
/opds/authors/<name>     that author's books
/opds/subjects           one entry per subject
/opds/subjects/<name>
/opds/series             one entry per series
/opds/series/<name>      in reading order
```

If none of your books record subjects, there's no **By subject** to open onto
nothing. The same goes for series.

**Searching** — add `?q=` to any book feed. That's the same parameter the
shelf's search box uses, so you can paste a URL from one into the other.

**Paging** — fifty books to a page, `?page=2` onwards.

## What each book carries

Everything the sync tool read out of the book: authors, publisher, date,
language, subjects, page count, and an identifier. One download link per format,
with its size, so your reader shows how big a download is before it starts.

Covers are included, and so is a link that opens the book in the browser reader
for clients that would rather hand it to a browser than download it.

Two things to expect:

- **Covers are WebP.** Thorium and Panels render them. KOReader's OPDS browser
  is text-only and never asks for one.
- **Every book is dated by when you last published the catalog**, because
  nothing records when an individual book was added. That's also why there's no
  **Recently added**.

A book with no downloadable file is left out of the feed rather than listed.

## There is no authentication

**Anyone who can reach your shelf can browse and download the whole library
through this feed.** It grants no access that the download links didn't already,
but it does make reaching all of it considerably easier — there's now a stable,
well-known URL that lists every book and every download link in a form built for
machines.

Put your shelf on a network you trust, or behind something that asks who's
calling. See [what's missing](roadmap.md).

`/opds` is disallowed in `robots.txt`, which keeps crawlers off it. That is not
a security measure.

## Checking it by hand

Both OPDS versions are served from the same URL. Your reader gets whichever it
asks for; force it with `?format=`:

```bash
curl -s http://localhost:3000/opds | xmllint --format -
curl -s -H 'accept: application/opds+json' http://localhost:3000/opds | jq
```

| | |
| --- | --- |
| **OPDS 1.2** | Atom XML. The default, and what every client speaks |
| **OPDS 2.0** | JSON. For Thorium and other newer clients |

## Troubleshooting

**Your reader shows an empty catalog.** Check that you've published — `/opds`
reflects your catalog, so an unpublished library gives an empty feed.

**Your reader can't reach it at all.** Use the address the device can reach, not
`localhost`. On the same network that's usually your machine's LAN IP.

**A book won't download.** Books with no file are left out of the feed
entirely, so if you can see it on the web shelf but not in your reader, check
that it published with a file.

**Feeds seem stale.** A feed is cached for a minute. Wait it out, or pull to
refresh if your client offers it.
