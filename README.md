# Bookshelf

A single server-rendered page that lists the books in an R2 bucket, filters them
with a search box, and serves downloads through the Worker.

## The repository

```
apps/bookshelf   the app: a Next.js Worker over object storage
packages/core    the library format and the ZIP reader
packages/sync    the CLI that builds a library and publishes it
books/           books in       ) configured in bookshelf.config.json,
library/         upload tree out)  both gitignored
```

A Turborepo workspace, so `packages/core` is built before anything that imports
it and the app and the CLI can never drift apart on what a library looks like.

## Layout

The bucket is one folder per book, plus a generated catalog:

```
library/
  essential-math-for-data-science/
    metadata.json                          <- source of truth for this book
    cover.webp
    essential-math-for-data-science.epub
    essential-math-for-data-science.pdf    <- any number of formats
  catalog.json                             <- derived, regenerable
```

`metadata.json` holds what the book says about itself — title, authors,
publisher, date, identifier, description — read out of its own package
document rather than guessed from a file name. `catalog.json` is only the
concatenation of them, so it can be regenerated, or swapped for a different
format entirely, without touching the library.

## Publishing

Drop books into `books/`, then:

```bash
npm run sync                # build library/ and upload it
npm run sync -- --force     # clear the bucket first
npm run sync -- --dry-run   # build only, upload nothing
```

Both directories are fixed by convention — `books/` in, `library/` out — and
both are gitignored. There is nothing to point at anything.

The script reads each book once for its metadata and its cover, groups files
sharing a name into one book with several formats, and hard-links book files
into the tree, so publishing 763 MB of books costs about a megabyte of disk.
Covers are thumbnailed to 240px WebP — a publisher cover is around a megabyte
against a 40x60 slot, so this is the difference between a shelf costing 65 MB
and one costing 0.5 MB.

A plain run uploads everything and removes anything the previous catalog listed
that the new one does not, so deleting a book locally deletes it remotely.
`--force` clears first instead, for when the bucket has drifted out of step.

| flag | |
| --- | --- |
| `--force` | clear the bucket before uploading |
| `--dry-run` | build the tree, publish nothing |
| `--local` | publish to the local miniflare bucket, for testing |
| `--target NAME` | where to publish (default `wrangler-r2`) |
| `--size N` | cover thumbnail height in pixels (default 240) |
| `--full` | keep full-size covers instead of thumbnailing them |

### Where it publishes

```
packages/sync/
  sync.mjs           the CLI
  lib/
    config.mjs       the fixed directories, and the bucket read from wrangler.jsonc
    zip.mjs          minimal ZIP reading
    epub.mjs         metadata and cover extraction
    images.mjs       thumbnailing, and PDF first-page rendering
    build.mjs        builds library/
    bucket.mjs       works out what to upload and what to remove
    targets/         one file per provider
      wrangler-r2.mjs
```

A target is `{ name, read, put, remove }`, optionally `list` and `concurrency`.
Adding a provider means adding a file under `targets/` and registering it —
nothing else changes.

Two things the wrangler target shows about that contract. It cannot enumerate a
bucket, because wrangler exposes only get, put and delete for objects — so it
leaves `list` undefined and the sync works out the previous contents from the
catalog it published last time. That is exact for a bucket only this script
manages, and blind to anything put there by other means, which `--force` says
out loud rather than pretending otherwise. It also declares
`concurrency: 1` locally, because every local invocation boots a miniflare
runtime that takes an exclusive lock on the state file and parallel writes fail
with `SQLITE_BUSY`.

## Commands

All of these run from the repository root; Turborepo builds whatever the task
depends on first.

```bash
npm run dev          # local dev server, against the local R2 bucket
npm run sync         # build the library and upload it to the bucket
npm run build        # build every workspace
npm run check-types  # typecheck every workspace
npm run preview      # build + run the Worker locally
npm run deploy       # build + deploy to Cloudflare Workers
npm run lint         # biome, across the repo
```

`npm run cf-typegen -w @bookshelf/app` regenerates `cloudflare-env.d.ts` after
editing `wrangler.jsonc`.

## Architecture

The app talks to interfaces, never to Cloudflare. Porting it means writing
adapters and one composition root, not touching the app.

```
src/services/
  ports/          the contracts
    storage.ts      head / read / readBytes / readRange
    cache.ts        ResponseCache, plus a no-op for when there isn't one
  adapters/       one implementation per platform
    r2-storage.ts     Cloudflare R2, via a Worker binding
    workers-cache.ts  the Workers Cache API
  catalog.ts      CatalogService — the shelf, from catalog.json
  content.ts      BookContentService — files from inside a book
  container.ts    createServices() wires them; getServices() is the only
                  place that knows this is Cloudflare
```

`createServices(storage, cache)` is the whole composition and is
platform-agnostic. `getServices()` is the Cloudflare entry point, and
`setServices()` replaces it with fakes in tests or with another runtime's
adapters at startup.

Deliberately absent from the storage port: `list`. The catalog is what
enumerates the library, so no caller may discover books by walking the bucket.

## Reading in the browser

Every book has a **Read** link. PDFs go straight to the browser's own viewer,
served with an inline disposition rather than as a download.

EPUB has no native support, so it is rendered by epub.js — but pointed at the
book's package document rather than the `.epub` itself. That matters: given a
`.epub` URL, epub.js downloads the whole archive before showing page one, which
for this library would mean 8 MB typical and 42 MB worst case. Given the `.opf`,
it fetches chapters one at a time from `/book/<key>/<entry>`, which reads that
one file out of the archive in R2 using ranged requests.

Two things keep it quick. Each entry is fetched in **one** ranged read rather
than two — the local header sits in front of the data at an offset the central
directory doesn't record, so the read covers header and data together and parses
the header back out. And a book opens at its first real section rather than its
cover. Together those take a cold open from 1,755 KB to 73 KB. Continuous scroll
is the exception at around 1.3 MB, because it starts at the top of the book and
so does render that cover.

Book markup is untrusted, so the reader renders it in an iframe sandboxed
without `allow-scripts`, and entry responses carry a `sandbox` CSP for anyone
who opens one of those URLs directly.

Reading position is kept in `localStorage` per book — per device, so it does not
follow you between them. Layout is a choice of two pages, one page, or
continuous scroll, remembered across books.

## Caching

The catalog is held in an in-isolate memo backed by the Workers Cache API, for
60 seconds — long enough that search keystrokes cost no I/O, short enough that a
newly published catalog appears on its own. Covers carry `max-age=86400` with an
ETag, so a re-uploaded cover becomes visible within the day and revalidation
costs a 304 rather than a re-download.

## Not done yet

- **There is no authentication.** Anyone with the URL can read and download the
  whole library.
- Reading progress is per-device.
