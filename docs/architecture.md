# Architecture

The app talks to interfaces, never to Cloudflare. Porting it means writing adapters and one composition root, not touching the app.

## The repository

```
apps/bookshelf       the app: a Next.js Worker over object storage
packages/core        the library format, the ZIP reader, the provider contract
packages/provider-r2 Cloudflare R2, both halves of it
packages/provider-fs the library as a directory on disk
packages/sync        the CLI that builds a library and publishes it
packages/fixtures    generated books, for tests and for the demo shelf
tools/               one-off scripts: the demo shelf, the Gutenberg fetcher
books/             books in       ) configured in bookshelf.config.json,
library/           upload tree out)  both gitignored
```

A Turborepo workspace, so `packages/core` is built before anything that imports
it and the app and the CLI can never drift apart on what a library looks like.
Every package is TypeScript compiled by `tsc`; the app is compiled by Next.
Tests live beside the code they exercise, as `test/*.test.ts` in each package,
and Node runs them from source by stripping the types. The `.mjs` that is left
is `tools/`, which is scripts, and one resolver hook the app's tests load.

One task in the graph is neither a build nor a test. `assets` copies pdf.js's
worker, CMaps, standard fonts and WebAssembly out of `pdfjs-dist` into the app's
`public/`, because pdf.js asks for those by URL at the moment it needs them and
no bundler ever sees the request. Everything that serves the app — `build`,
`dev`, `bundle`, `preview`, `deploy` — depends on it. It is uncached on purpose:
the script stamps the version it copied, so a second run compares one file and
exits, which is cheaper than restoring four megabytes from a cache.

## Services and ports

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
  errors.ts       the difference between absent and unreachable
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

## Absent, or unreachable

Every service tells three states apart, and the third is the one worth naming.

**Present** is the ordinary case. **Absent** is ordinary too, and most of the
app's care goes into it: an unpublished catalog is an empty shelf, a library with
no profile file has one implicit profile, a book nobody has opened has no saved
position, a corrupt file reads as though it were not there. None of those is an
error, and none of them fails a page.

**Unreachable** is storage that exists and is failing — a network blip, a bucket
that has gone away, a disk that has. It used to arrive as whatever the provider
happened to throw, which is indistinguishable from a bug and takes a page down
with it. `LibraryUnavailableError` names it, so each caller can answer for
itself, and the answers differ because the stakes do:

| | when the library cannot be read |
| --- | --- |
| the catalog | the last one read, if there is one; otherwise the shelf says so |
| profiles | refuses — see below |
| reading positions | none, and a save answers `false` |
| a book's contents | refuses, and the route answers `503` rather than `404` |

Reading positions degrade to nothing because that costs nothing: the reader
reconciles whatever it is given against the copy the browser kept, newest wins,
so a position missing from an answer is not a position lost. **Saving** is the
opposite, and the one place degrading would lose data — the file holds every
book a profile has open and is rewritten whole, so writing it after a failed
read would replace all of those positions with one. A reader told `false` keeps
its place locally and tries again; that is the same path a read-only library
already takes.

Profiles refuse rather than degrade for a related reason. The answer decides
which file a position is written to, and falling back to the implicit default
would resolve every reader to `default` — writing one person's place in a book
into a file belonging to nobody. Failing to render is recoverable; quietly
writing into the wrong file is not.

The shelf then treats its reads by how much it needs them. The catalog is the
page, so a failure there becomes a state that says the library is unreachable.
Profiles and positions are not, so a failure there renders the shelf without a
profile chip and without Continue buttons, and says which is missing. A `503`
carries `Retry-After` and `no-store`, because the next request may well succeed
and a cached outage outlives the outage.

Anything that is *not* an unreachable library is left to throw, and reaches
`app/error.tsx`. A page rendering less than it wanted to is a reasonable answer
to an outage and a terrible one to a bug.

The app names both providers with fixed specifiers and picks between them at
startup; the CLI resolves its provider from config at run time, because a CLI
is not bundled ahead of time. Same package either way —
`@bookshelf/provider-r2/worker` for one, `@bookshelf/provider-fs/node` for the
other.

One ZIP reader serves both sides because they differ only in where the bytes
come from: the CLI holds a whole book in memory, the app pulls one chapter at a
time out of storage. Decompression goes through `DecompressionStream` rather
than `node:zlib`, which is what lets the same code run in workerd and in Node.

## The readers

```
apps/bookshelf/src/app/read/[...key]/
  page.tsx          picks a reader from the file's extension, and is the only
                    place that knows there is more than one
  position.ts       keeping a place: the browser's copy first, the library's
                    after a pause, reconciled newest-wins on the way in. Shared,
                    because only what a position *is* differs by format
  epub-reader.tsx   epub.js, pointed at the package document
  pdf-reader.tsx    pdf.js: layout, zoom, tint, and the chrome around a page
  pdf-page.tsx      one page — a box of the right shape, drawn when it is near
  pdf-sidebar.tsx   contents and search, which are both lists of places to go
  pdf-search.ts     the scan, debounced and streamed
  pdf-document.ts   every call into pdf.js that is not React: opening a
                    document, its outline, its text, its text layer

apps/bookshelf/src/lib/
  local.ts          localStorage, for what belongs to a device rather than to a
                    profile: a layout, a zoom, a tint, and the browser's copy of
                    a position
```

Both readers are client components and both load their library with a dynamic
`import()`, because epub.js and pdf.js each reach for `window` as they
initialise and neither survives the server render. The server's part is small
and the same either way: resolve who is reading, hand over their saved position,
and say whether the library can be written to.

See [reading in the browser](reader.md) for what each reader does with that.

## Pages that are not showing a shelf

```
apps/bookshelf/src/app/
  state.tsx         the shared block: glyph, title, sentence, a way out
  not-found.tsx     a URL that matches nothing, and notFound() from the reader
  error.tsx         the route boundary — a bug, or an outage nobody accounted for
  global-error.tsx  when the root layout itself is what failed
```

`error.tsx` deliberately does not show the error's message: Next redacts it in
production and hands over a digest instead, so anything shown would read as
detail in development and as nothing in production. The digest is shown, since
it is what ties what a reader saw to what the log recorded.

## Caching

The catalog is held in an in-isolate memo backed by the Workers Cache API, for
60 seconds — long enough that search keystrokes cost no I/O, short enough that a
newly published catalog appears on its own. Covers carry `max-age=86400` with an
ETag, so a re-uploaded cover becomes visible within the day and revalidation
costs a 304 rather than a re-download.
