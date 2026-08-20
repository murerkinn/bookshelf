# Bookshelf

[![CI](https://github.com/murerkinn/bookshelf/actions/workflows/ci.yml/badge.svg)](https://github.com/murerkinn/bookshelf/actions/workflows/ci.yml)

A self-hosted library for the ebooks you already own. One server-rendered page
lists them, filters them with a search box, serves downloads, and reads EPUBs
in the browser — as a Cloudflare Worker over R2, or as a Node server over a
directory on disk.

## Getting started

Node 22 or newer, and a Unix-like system: the sync tool finds its image tools
with `which`, so Windows is not supported.

```bash
git clone https://github.com/murerkinn/bookshelf.git
cd bookshelf
npm install
```

Put some books — EPUB or PDF — in `books/`, then choose where the library
should live.

### On a machine you own

No account anywhere. Point `bookshelf.config.json` at a directory, publish into
it, and run the app:

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

```bash
npm run sync -- --create   # builds library/, then publishes it to shelf-data/
npm run build
npm start -w @bookshelf/app
```

`library/` is the tree the sync tool builds; `directory` is where it publishes
to, and it holds the books being served. Keep it out of the repository —
`shelf-data/` already is.

### On Cloudflare

Needs a Cloudflare account and `npx wrangler login`. Two files carry this
project's own deployment and are meant to be edited:

| file | change |
| --- | --- |
| `bookshelf.config.json` | `storage.bucket`, and `storage.jurisdiction` — delete that key unless you want EU data residency |
| `apps/bookshelf/wrangler.jsonc` | `name`, and the `r2_buckets` entry to match the above |

```bash
npm run sync -- --create   # creates the bucket, then uploads to it
npm run deploy
```

The two must agree about which bucket holds the library, or the app will serve
an empty shelf. They are checked against each other before anything uploads,
and a mismatch is reported rather than published through.

### Covers

Thumbnailing is done by external tools, and the sync tool degrades quietly
without them — a shelf of untouched publisher covers costs around 65 MB against
0.5 MB thumbnailed.

| tool | for | absent |
| --- | --- | --- |
| `cwebp` (libwebp) | cover thumbnails | `sips` on macOS, otherwise covers are published full size |
| `pdftoppm` (poppler) | covers out of PDFs | `sips` or `qlmanage` on macOS, otherwise PDFs get no cover |

```bash
brew install webp poppler        # macOS
apt install webp poppler-utils   # Debian, Ubuntu
```

**There is no authentication.** Anyone who can reach the app can read and
download the whole library, so put it on a network you trust or behind
something that asks who is calling. See [Not done yet](#not-done-yet).

## The repository

```
apps/bookshelf       the app: a Next.js Worker over object storage
packages/core        the library format, the ZIP reader, the provider contract
packages/provider-r2 Cloudflare R2, both halves of it
packages/provider-fs the library as a directory on disk
packages/sync        the CLI that builds a library and publishes it
books/             books in       ) configured in bookshelf.config.json,
library/           upload tree out)  both gitignored
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
  .bookshelf/                              <- the app's, not the sync tool's
    profiles.json
    progress/<profile>.json
```

`metadata.json` holds what the book says about itself — title, authors,
publisher, date, identifier, description — read out of its own package
document rather than guessed from a file name. `catalog.json` is only the
concatenation of them, so it can be regenerated, or swapped for a different
format entirely, without touching the library.

`.bookshelf/` is the one thing here the sync tool did not put there, and so
the one thing it must never take away — see [Profiles](#profiles).

## Publishing

Drop books into `books/`, then:

```bash
npm run sync                # build library/ and upload it
npm run sync -- --force     # clear the bucket first
npm run sync -- --dry-run   # build only, upload nothing
```

Directories, provider and bucket come from `bookshelf.config.json`, found by
walking up from the working directory:

```json
{
  "input": "books",
  "output": "library",
  "coverHeight": 240,
  "storage": {
    "provider": "r2",
    "bucket": "books",
    "jurisdiction": "eu",
    "worker": "apps/bookshelf"
  }
}
```

Without a config file the conventional layout applies — `books/` in, `library/`
out — so the defaults are what the file above spells out.

Everything under `storage` except `provider` belongs to the provider, and is
passed to it untouched: `bucket`, `jurisdiction` and `worker` are R2's keys, not
the CLI's. `worker` is where wrangler runs; leave `bucket` out and it is read
from that Worker's `wrangler.jsonc` instead, and if both are given and disagree
the provider says so before uploading anything the app will not be able to see.

The script reads each book once for its metadata and its cover, groups files
sharing a name into one book with several formats, and hard-links book files
into the tree, so publishing 763 MB of books costs about a megabyte of disk.
Covers are thumbnailed to 240px WebP — a publisher cover is around a megabyte
against a 40x60 slot, so this is the difference between a shelf costing 65 MB
and one costing 0.5 MB.

A plain run uploads everything and removes anything the previous catalog listed
that the new one does not, so deleting a book locally deletes it remotely.
`--force` clears first instead, for when the bucket has drifted out of step.
Neither touches `.bookshelf/`: providers leave it out of what they enumerate,
so clearing the library never clears everyone's bookmarks with it.

| flag | |
| --- | --- |
| `--force` | clear the bucket before uploading |
| `--dry-run` | build the tree, publish nothing |
| `--local` | publish to the local miniflare bucket, for testing |
| `--create` | provision the destination first, if the provider can |
| `--provider NAME` | which provider to publish through (default `r2`) |
| `--size N` | cover thumbnail height in pixels (default 240) |
| `--full` | keep full-size covers instead of thumbnailing them |

### Where it publishes

```
packages/sync/
  sync.mjs           the CLI
  lib/
    config.mjs       bookshelf.config.json, resolved
    epub.mjs         metadata and cover extraction
    images.mjs       thumbnailing, and PDF first-page rendering
    build.mjs        builds library/
    bucket.mjs       works out what to upload and what to remove
    providers.mjs    resolves a provider by importing its package
```

A provider is a package, not a file in the CLI. `providers.mjs` maps the short
ids to the packages shipped here and imports anything else as given, so a
provider written by someone else needs nothing added: install it, name it in
the config, done.

Each provider has two faces, because the app and the CLI run in different places
and want different things:

```
@bookshelf/provider-r2           its manifest — id, options, capabilities
@bookshelf/provider-r2/worker    Storage: head, read, readBytes, readRange,
                                 and optionally write, remove
@bookshelf/provider-r2/node      StorageAdmin: read, put, remove,
                                 and optionally create, list, removeAll
```

The manifest is importable without credentials or a runtime, which is what lets
the CLI name a provider's settings, and the docs describe them, without
connecting to anything.

Entry points are named for the runtime they need rather than the face they
implement. R2 splits across two, because the app reads it from workerd and the
CLI writes it from Node. The filesystem provider has one, `/node`, because both
of its halves need a filesystem — and that is the same fact as the app having to
run on a machine that has one.

| | `r2` | `fs` |
| --- | --- | --- |
| read | Worker binding | `node:fs` |
| publish | wrangler CLI | copies, hard-linked where it can |
| `create` | `wrangler r2 bucket create` | `mkdir -p` |
| `list` | — | walks the directory |
| `removeAll` | — | empties the directory |
| app can write | binding `put` | atomic rename |
| credentials | a wrangler login | none |

`create`, `list` and `removeAll` are optional because providers genuinely differ
in what their APIs offer, and the alternative to optionality is a provider that
lies. The two shipped here differ in exactly that way, which is the point of
having two.

R2 over wrangler cannot enumerate: wrangler exposes only get, put and delete for
objects. So it implements `create` and leaves `list` and `removeAll` undefined,
and the sync works out the previous contents from the catalog it published last
time — exact for a bucket only it manages, blind to anything put there by other
means, and `--force` says so rather than implying it cleared more than it did.

A directory can be walked, so the filesystem provider implements everything, and
`--force` on it empties the destination for real. Same flag, same code path in
`bucket.mjs`, different guarantee — stated rather than assumed.

The same provider declares `concurrency: 1` when publishing locally, because
every local invocation boots a miniflare runtime that takes an exclusive lock on
the state file and parallel writes fail with `SQLITE_BUSY`.

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
packages/core/src/
  provider.ts     the contract — Storage, StorageAdmin, the manifest
  catalog.ts      the published shape — Book, Catalog, the file names, the
                  version. Both sides import it, neither redeclares it.
  state.ts        the written-back shape — Profile, Progress, and the
                  reserved prefix they live under
  bytes.ts        ByteSource: size() and read(offset, length)
  zip.ts          the ZIP reader, written against ByteSource

apps/bookshelf/src/services/
  ports/
    cache.ts      ResponseCache, plus a no-op for when there isn't one
  adapters/
    workers-cache.ts  the Workers Cache API
  catalog.ts      CatalogService — the shelf, from catalog.json
  content.ts      BookContentService — files from inside a book
  profiles.ts     ProfileService — who is reading
  progress.ts     ProgressService — how far they got
  session.ts      which profile a request belongs to, and how its cookie is set
  container.ts    createServices() wires them; getServices() is the only
                  place that names a provider
```

`createServices(storage, cache)` is the whole composition and is
platform-agnostic. `getServices()` is the entry point, and `setServices()`
replaces it with fakes in tests or with another runtime's implementations at
startup.

Deliberately absent from `Storage`: `list`. The catalog is what enumerates the
library, so no request may discover books by walking the bucket. Enumeration
lives on `StorageAdmin`, which never runs in the app.

`write` and `remove` are on `Storage` but optional, because a provider may
front a destination that genuinely cannot be written to. Callers narrow with
`writableStorage()` and degrade rather than throwing, so a read-only library is
a working shelf whose positions stay in the browser.

The app names both providers with fixed specifiers and picks between them at
startup; the CLI resolves its provider from config at run time, because a CLI
is not bundled ahead of time. Same package either way —
`@bookshelf/provider-r2/worker` for one, `@bookshelf/provider-fs/node` for the
other.

One ZIP reader serves both sides because they differ only in where the bytes
come from: the CLI holds a whole book in memory, the app pulls one chapter at a
time out of storage. Decompression goes through `DecompressionStream` rather
than `node:zlib`, which is what lets the same code run in workerd and in Node.

## Running it without Cloudflare

The filesystem provider is what makes the app runnable on a machine you own — a
box on your own network, or a VPS — with no account anywhere.

```jsonc
// bookshelf.config.json
{ "storage": { "provider": "fs", "directory": "shelf-data" } }
```

```bash
npm run sync -- --create   # publishes into shelf-data/
npm run build
npm start -w @bookshelf/app
```

No environment variables: **`next.config.ts` reads the same
`bookshelf.config.json` the sync tool reads, at build time, and bakes the
provider into the bundle.** One file decides where the books go and where the
app looks for them, which is the only way the two cannot disagree.

It has to be build time rather than request time. On Workers there is no
filesystem to read a config file from, and the two modes are different artifacts
anyway — one Worker, one Node server. `BOOKSHELF_PROVIDER` and
`BOOKSHELF_DIRECTORY` still override at startup, for a deployment whose library
sits somewhere other than where it was built.

`getServices()` imports each provider dynamically, because the two are not
interchangeable at run time: one needs a Worker binding, the other a filesystem,
and whichever the deployment lacks must never be loaded.

Keys arriving from URLs are resolved against the library root and rejected if
they escape it, so `../` in a request cannot reach a file outside the published
tree.

There is no Workers cache in this mode, and none is needed: the catalog memo
still spares the repeated reads, and the files are already local.

### Choosing wrong

Building for Cloudflare and then starting the app on Node does not fail, which
is the trap. `getCloudflareContext()` quietly returns a local development proxy,
so the shelf renders — showing whatever the local miniflare bucket holds rather
than what is in R2, and looking merely empty rather than misconfigured.

The app detects that case (a Node process, in production, with no Cache API) and
says so on startup. A Worker with no `BOOKS` binding, and a filesystem build
with no directory, both fail outright with what to do about it.

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

## Profiles

Everyone reading from the same library keeps their own place in each book. A
library that has never been configured has one profile, called Reader, and no
profile file at all — the default is implicit until something is actually
changed, so a fresh install writes nothing it might never need.

The shelf header holds the switcher: who is reading, everyone else in one
click, and a field to add someone. Creating a profile starts reading as it,
wherever it was created from — the alternative leaves the shelf showing another
person's positions with nothing to say why. `/profiles` is for renaming and
deleting, which are rarer and want more room.

It is a `<details>` element, so switching and creating are ordinary form posts
and work with scripting off; the client half only adds closing on Escape or on
a click elsewhere. The cookie is set per request rather than per build, because
a `Secure` cookie decided by NODE_ENV is one a browser silently discards over
plain HTTP — which is exactly how a box on your own network is reached.

Profiles are not accounts. A cookie names one; it does not prove anything about
who is holding it, and anyone who can reach the library can read as any profile
in it. That is the right amount of ceremony for a shelf shared with the people
you live with, and the wrong amount for one on the open internet — see
[Not done yet](#not-done-yet).

Positions are written to the browser first and to the library after a pause,
which is what keeps page turns off the network: a chapter's worth of turns
collapses into one write, and leaving the page flushes what is outstanding
through `sendBeacon`. Both copies carry a timestamp and the newest wins, so
picking a book up on a phone resumes where the laptop left off, and a reader
that was offline does not lose its place to a stale copy.

Storage the app cannot write to is not an error. `writableStorage()` returns
null, the profiles page says so, and reading positions stay in the browser
exactly as they did before any of this existed.

This costs one read of the profile's positions per shelf render, on top of the
cached catalog. It is not cached, because a position saved a moment ago should
show as *Continue* immediately.

## Caching

The catalog is held in an in-isolate memo backed by the Workers Cache API, for
60 seconds — long enough that search keystrokes cost no I/O, short enough that a
newly published catalog appears on its own. Covers carry `max-age=86400` with an
ETag, so a re-uploaded cover becomes visible within the day and revalidation
costs a 304 rather than a re-download.

## Not done yet

- **There is no authentication.** Anyone with the URL can read and download the
  whole library — and pick any profile while doing it. Profiles are a way to
  keep housemates' bookmarks apart, not a way to keep anyone out.
- Two devices reading as one profile at the same time is last-write-wins.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: Node 22, `npm
install`, `npm run lint` and `npm run check-types` before you push, and there
are no tests yet — so say what you ran.

Storage providers are the extension point and do not have to live here: a
package published by anyone can be installed and named in the config.

## License

MIT — see [LICENSE](LICENSE).

That covers the code. It says nothing about the books you put in a library
built with it, whose copyright is between you and their publishers.
