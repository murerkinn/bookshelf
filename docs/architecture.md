# Architecture

The app talks to interfaces, never to Cloudflare. Porting it means writing adapters and one composition root, not touching the app.

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

## Caching

The catalog is held in an in-isolate memo backed by the Workers Cache API, for
60 seconds — long enough that search keystrokes cost no I/O, short enough that a
newly published catalog appears on its own. Covers carry `max-age=86400` with an
ETag, so a re-uploaded cover becomes visible within the day and revalidation
costs a 304 rather than a re-download.
