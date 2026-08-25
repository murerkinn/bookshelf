# Architecture

How the code is laid out, for when you're working on it. If you just want to run
a shelf, you don't need this page.

## The repository

```
apps/bookshelf       the app: a Next.js Worker, or a Node server
packages/core        the library format, the readers, the provider contract
packages/provider-r2 Cloudflare R2
packages/provider-fs a directory on disk
packages/sync        the CLI that builds a library and publishes it
packages/fixtures    generated books, for tests and the demo shelf
tools/               the demo shelf script
```

It's a Turborepo workspace, so `packages/core` builds before anything that
imports it. Every package is TypeScript compiled by `tsc`; the app is compiled
by Next. Tests live beside the code they exercise as `test/*.test.ts`, and Node
runs them from source.

One task is neither a build nor a test: `assets` copies pdf.js's worker, CMaps,
standard fonts and WebAssembly out of `pdfjs-dist` into the app's `public/`.
Everything that serves the app depends on it. You never need to run it by hand.

## The rule to keep

**The app talks to interfaces, never to Cloudflare.** If you find yourself
importing `@bookshelf/provider-*` anywhere except
`apps/bookshelf/src/services/container.ts`, something has gone wrong.

## Services and ports

```
packages/core/src/
  provider.ts     the contract — Storage, StorageAdmin, the manifest
  catalog.ts      the published shape — Book, Catalog, file names, version
  state.ts        the written-back shape — Profile, Progress, their prefix
  bytes.ts        ByteSource: size() and read(offset, length)
  zip.ts          the ZIP reader, written against ByteSource
  pdf.ts          the PDF reader, likewise

apps/bookshelf/src/services/
  ports/cache.ts          ResponseCache, plus a no-op
  adapters/workers-cache.ts
  catalog.ts      CatalogService — the shelf, from catalog.json
  content.ts      BookContentService — files from inside a book
  profiles.ts     ProfileService — who is reading
  progress.ts     ProgressService — how far they got
  errors.ts       the difference between absent and unreachable
  session.ts      which profile a request belongs to
  container.ts    createServices() wires them; getServices() is the only
                  place that names a provider
```

Use `setServices()` to substitute fakes in tests.

Three constraints you need to respect when adding to this layer:

- **`Storage` has no `list`.** The catalog enumerates the library, so no request
  can discover books by walking the bucket. Enumeration lives on `StorageAdmin`,
  which never runs in the app.
- **Put every key from a URL through `parseBookKey`.** The three routes that
  serve bytes do this and answer `404` to anything that isn't a file inside a
  book's folder. Without it, a URL can read any object the provider will answer
  for — including `.bookshelf/profiles.json`.
- **Narrow with `writableStorage()` before writing.** `write` and `remove` are
  optional on `Storage`. Degrade rather than throwing.

## Absent, or unreachable

Every service tells three states apart.

**Present** and **absent** are both ordinary. An unpublished catalog is an empty
shelf, a library with no profile file has one implicit profile, a book nobody
opened has no saved position, a corrupt file reads as absent. None of these
fails a page.

**Unreachable** is storage that exists and is failing. It arrives as
`LibraryUnavailableError`, and each caller answers for itself:

| | when the library cannot be read |
| --- | --- |
| the catalog | the last one read, if there is one; otherwise the shelf says so |
| profiles | refuses |
| reading positions | none, and a save answers `false` |
| a book's contents | refuses, and the route answers `503` |

When you add a caller, follow that table. Reading positions degrade to nothing
safely because the browser keeps a copy. Saving must not degrade — the file
holds every book a profile has open and is rewritten whole, so writing after a
failed read would replace all of them with one. Profiles must not degrade
either, because falling back to the default would write one person's place into
a file belonging to nobody.

Anything that isn't `LibraryUnavailableError` should throw and reach
`app/error.tsx`.

## The readers

```
apps/bookshelf/src/app/read/[...key]/
  page.tsx          picks a reader from the extension — the only place that
                    knows there is more than one
  position.ts       keeping a place, shared by both readers
  epub-reader.tsx   epub.js, pointed at the package document
  pdf-reader.tsx    pdf.js: layout, zoom, tint, chrome
  pdf-page.tsx      one page
  pdf-sidebar.tsx   contents and search
  pdf-search.ts     the scan, debounced and streamed
  pdf-document.ts   every call into pdf.js that is not React

apps/bookshelf/src/lib/local.ts   localStorage: layout, zoom, tint, and the
                                  browser's copy of a position
```

Both readers are client components and load their library with a dynamic
`import()` — epub.js and pdf.js each reach for `window` as they initialise and
neither survives the server render.

## The OPDS catalog

```
apps/bookshelf/src/app/opds/[[...path]]/route.ts   the whole route
apps/bookshelf/src/lib/opds/
  feed.ts         the model, shaped after OPDS 2.0
  browse.ts       the groupings: by author, by subject, by series
  xml.ts          escaping
  atom.ts         OPDS 1.2, and the OpenSearch document
  json.ts         OPDS 2.0
  serve.ts        the URL space, format negotiation, the ETag, the response
```

**Don't import `next/headers` under `lib/opds/`.** `serveOpds` takes the shelf
and the origin as parameters, which is what keeps every feed reachable from
`test/opds.test.ts`. That's also why `siteOrigin()` lives in `lib/origin.ts`
rather than in `lib/site.ts`.

## Error pages

```
apps/bookshelf/src/app/
  state.tsx         the shared block: glyph, title, sentence, a way out
  not-found.tsx     a URL that matches nothing
  error.tsx         the route boundary
  global-error.tsx  when the root layout itself failed
```

`error.tsx` shows the digest rather than the message — Next redacts messages in
production.

## Caching

The catalog is held in an in-isolate memo backed by the Workers Cache API for 60
seconds. Covers carry `max-age=86400` with an ETag. OPDS feeds carry
`public, max-age=60`, a weak ETag, and `Vary: Accept`.
