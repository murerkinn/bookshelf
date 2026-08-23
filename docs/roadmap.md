# Roadmap

What is missing, roughly in the order it is worth doing. Each entry says what
the code does today, what it should do, and which files carry the change — so
that picking one up does not start with a re-reading of the repository.

Priority here means *how much of the project is incomplete without it*, not how
interesting it is. A library that can hold PDFs but cannot read a PDF's title
is unfinished in a way that a library without annotations is not.

## Now

The five things that leave a visible hole in what is already shipped.

### 1. Read metadata out of PDFs — **done**

`packages/sync/src/lib/build.ts` used to call `readEpub` and nothing else, so a
PDF-only book got its title from its file name and had no authors, publisher,
date, description or identifier at all.

What landed:

- `packages/core/src/pdf.ts` — a read-only PDF reader over `ByteSource`, the
  same shape as the ZIP reader and for the same reason. The cross-reference
  table in both its forms, object streams, Flate with PNG predictors, and a
  full-file scan that recovers a document whose table is wrong. Verified
  against 37 real PDFs with `pdfinfo` as the reference, and it reads a 448-page
  book's metadata in 21 ranged reads of 42 KB — which is what makes it reusable
  for **#2** and **#3** rather than only by the CLI.
- `packages/sync/src/lib/pdf.ts` — XMP first, information dictionary filling in
  field by field, and a title chosen by trying each source in turn rather than
  believing whichever won.
- `packages/sync/src/lib/metadata.ts` — what both readers share: entity decoding,
  Dublin Core, author splitting, junk-title rejection, checksummed ISBNs.
- `dc:subject`, Calibre and EPUB 3 series, ISBNs and page counts, on both
  formats. `Book` grew `subjects`, `series`, `seriesIndex`, `isbn` and `pages`,
  all optional, no `CATALOG_VERSION` bump.
- PDF fixtures and tests, plus `npm test`. Both since moved: the generators to
  `@bookshelf/fixtures`, the tests beside the code they exercise.

Deliberately left out: **decryption**. The permissions-only encryption
publishers apply leaves a PDF's structure readable and its strings ciphertext,
so those books report no metadata rather than mojibake, and `sync` marks them
`[encrypted, no metadata]`. Supporting them means the standard security handler
with an empty user password — MD5 and RC4 by hand, since neither is in WebCrypto
— and it is worth doing only if publisher PDFs turn out to be a common case in
practice. One file in the 37-PDF sample was encrypted, and it was a certificate.

### 2. A real PDF reader

`apps/bookshelf/src/app/read/[...key]/page.tsx` hands anything that is not an
EPUB to an `<iframe>` pointed at `/download/<key>?inline=1`. That works — the
browser's viewer is good — but the whole of the reader's behaviour is lost with
it: no saved position, so **Continue** never appears for a PDF; no table of
contents; no layout choice; a full download before the first page; and on iOS
Safari an inline PDF in an iframe renders one page and stops.

Add `pdf-reader.tsx` next to `epub-reader.tsx`, on `pdf.js`, and select on it in
the same place the iframe is selected on now. The pieces that already exist and
should be reused rather than rebuilt:

- the debounced-write-plus-`sendBeacon` position sync from `epub-reader.tsx`,
  which is the part with the subtle bits in it (browser copy first, newest-wins
  reconciliation, flush on `pagehide`);
- `ProgressService`, unchanged, once `BookProgress` in
  `packages/core/src/state.ts` gains an optional `page?: number`. `cfi` and
  `href` are EPUB-shaped; a page number is the PDF equivalent, and the type is
  a union of position kinds rather than a second file. `STATE_VERSION` stays
  where it is: a reader that meets a `page` it does not understand starts at
  the beginning, which is the existing behaviour for an unknown book.
- range reads, which **#3** has already landed — `pdf.js` asks for byte ranges
  when the server says it may, and `/download` now says it may, which is what
  turns a 40 MB PDF into a first page in a few hundred kilobytes.

The outline (`getOutline()`) fills the same contents dropdown the EPUB reader
uses, so the chrome in `page.tsx` stays one component rather than two.

### 3. Range requests on `/download` — **done**

`apps/bookshelf/src/app/download/[...key]/route.ts` used to return the whole
object every time: no `Accept-Ranges`, an ignored `Range`, and an ignored
`If-None-Match` even though `cover/[...key]/route.ts` handled one two
directories away.

What landed:

- `packages/core/src/range.ts` — the `Range` header parsed against an object's
  length, plus `clampRange`, `Content-Range` formatting and the `If-Range`
  check. In core because a provider and a route both need to agree about what a
  byte range is.
- `Storage.read` takes an optional `range`, and `StoredContent` reports the
  `range` it actually served. Providers may decline, and the route reads what
  came back rather than what it asked for — so a provider that ignores ranges
  serves complete responses instead of partial ones mislabelled as complete.
- Both shipped providers implement it: R2 through the binding's `range`, the
  filesystem through `createReadStream` bounds.
- The route now answers `206` with `Content-Range`, `416` naming the real
  length, `304` on a matching validator, and honours `If-Range` so a resumed
  download cannot splice two versions of a book together.
- `normaliseEtag` was in four places by the end of this; it is now one export.

Verified against the local R2 bucket through workerd: a 1.27 MB book reassembled
from twenty separate 64 KB range requests matches the original by md5, suffix
and open-ended ranges are byte-exact, `curl -C -` resumes an interrupted
download to a correct file, and multi-range and unknown-unit requests degrade to
`200`. `packages/core/test/range.test.ts` and `packages/provider-fs/test/storage.test.ts`
cover the parsing and the filesystem half.

One thing this did not get: a `Content-Length` on a streamed response. workerd
sends `Transfer-Encoding: chunked` for a body whose length it was not told, and
the length is not knowable without buffering the book. A partial response still
states its extent in `Content-Range`; what is missing is the total a browser's
download UI would show a percentage against. It was already this way before
these changes.

### 4. Something that asks who is calling

The README says it twice and it is the honest headline: there is no
authentication. Anyone who reaches the app reads and downloads everything and
may pick any profile while doing it.

`BOOKSHELF_READ_ONLY` was the first half of making a public instance safe —
it stops the library being *changed*. The second half is stopping it being
*read*, and it should follow the same shape: enforced where the work happens,
not by hiding the links.

Worth doing as a middleware plus a small port, so that the deployment picks a
mechanism rather than the app hard-coding one:

- **Cloudflare Access** in front of the Worker — nothing to write, nothing to
  store, and the right answer for an R2 deployment. Verify the `Cf-Access-Jwt-
  Assertion` header rather than trusting the tunnel, and the verified identity
  can pick the profile, which is a better answer than a cookie anyone can set.
- **A shared password** and a signed, `HttpOnly` cookie, for the Docker and VPS
  cases where there is no identity provider — the small thing that makes a
  home server on a Tailnet or behind a reverse proxy reasonable.
- **Per-profile passcodes** as a later refinement, once profiles mean something
  more than "whose bookmarks are these".

Whatever lands, `docs/` needs a page on it and the README's *Not done yet* gets
shorter.

### 5. Tests, and a CI job that runs them — **done**

`CONTRIBUTING.md` said there were none, and `ci.yml` said the same in a comment:
*"It belongs on a test job, once there is one."* There is one now.

**105 tests**, `node:test`, no new dependency, ~2s. `npm test` runs them;
`npx turbo run test` builds the packages they import first, which is what CI
does and what works from a cold checkout. A fourth CI job runs it, and the
comment that promised it now points at it.

What is covered, and why each was worth writing:

- **`zip.ts`** — the single-ranged-read trick `docs/reader.md` is proud of is now
  pinned by counting the reads, along with data descriptors, deflated entries, an
  extra field larger than the reader's speculative allowance, a trailing archive
  comment, Zip64 refusal, and the stale-directory case that returns null rather
  than serving one book's bytes as another's.
- **`epub.ts`** — entity decoding, a default-namespaced `<title>`, cover
  discovery all three ways, `resolvePath` climbing out of its own directory,
  percent-encoded hrefs, series from either convention, ISBN validation.
- **`build.ts`** — through `buildLibrary` rather than its parts, so what is
  pinned is the tree that comes out: the `-2` collision suffix, format grouping,
  AppleDouble sidecars, a failure that does not take the run down, and that
  `metadata.json` and the catalog entry stay identical.
- **`bucket.ts`** — the publish diff, which is the one place a bug deletes
  someone's library: what is removed, what `--force` clears, and that a provider
  that cannot enumerate says `exact: false` rather than implying more than it did.
- **`provider-fs`** — ranged reads, and that `list` and `removeAll` leave
  `.bookshelf/` alone. That is the guarantee standing between `--force` and
  everyone's bookmarks.
- **core helpers** — the JSONC stripper against a URL inside a string, profile id
  constraints, and that `readOnlyStorage` forwards read options, which is exactly
  how a read-only library would have silently lost ranged reads.

Plus `range.test.mjs` and `pdf.test.mjs` from **#1** and **#3**.

The app's service layer is covered too, which took one change to reach: none of
those classes declares its fields in its constructor signature any more.
`constructor(private readonly storage: Storage)` is TypeScript-only syntax that
Node's strip-only mode refuses, and `--experimental-transform-types`, which
handled it, is gone as of Node 26 — so the fields are declared on the class and
assigned in the constructor body. Two lines instead of one, no transpiler, and
`this.storage` unchanged everywhere else. What that buys:

- **`ProfileService`** — the implicit default that is never written until there
  is a reason to, creating the second profile recording the first, id collisions,
  the household cap, never removing the last one, a removed profile taking its
  reading positions with it, a corrupt profile file falling back rather than
  taking the shelf down, and entries whose ids could not be file names being
  dropped rather than trusted.
- **`ProgressService`** — positions kept per profile, only the fields that were
  given, and a library that cannot be written to answering `false` instead of
  throwing at the moment someone turns a page.
- **`CatalogService`** — search across title, authors and publisher; that a warm
  isolate answers with no reads at all; and that the response cache is the tier
  behind the memo. `resetCatalogMemo()` finally has the callers it was written
  for.
- **`BookContentService`** — that a book's directory is read once rather than
  once per chapter, that a path the archive does not list is not a reason to read
  it again, and that a republished book is re-read rather than served from a
  stale directory.

`apps/bookshelf/test/lib/storage.ts` is what makes those reachable: a library in memory that
implements the provider contract, counts what was asked of it, and can be told
it is not writable.

Still out of reach, and left there: routes, pages and the composition root,
which need `next/headers` and a Cloudflare context. The filesystem quickstart is
what covers those.

## Next

Where the reading and browsing experience is thin rather than absent.

### 6. Typography and theme in the reader

`epub-reader.tsx` offers three layouts and nothing else. Publisher CSS decides
the typeface, the measure and the colours, which is why a book renders as black
on white next to a shelf that follows the system theme.

`rendition.themes` is the hook: font size, family (a serif, a sans, and the
reader's own choice), line height, margins, and a dark and sepia theme
registered as overrides. Two cautions worth writing down before starting — an
injected theme must not override a book's own semantic styling into mush
(dropped caps, verse, code samples), and dark mode needs to deal with a book's
white-background PNG diagrams rather than pretending they aren't there.
Preferences belong next to `MODE_STORAGE_KEY`, per device rather than per
profile: it is a property of the screen being read on.

### 7. Where you are in the book

The footer shows a spine href. `book.locations.generate()` gives a percentage
through the book, a page count, and "N pages left in this chapter" — which is
the single most-missed number in a web reader.

It costs one pass over the spine, so generate it after first paint, cache the
serialized locations per book in `localStorage`, and let the shelf show a
progress ring on the cover once it has one. That last part needs no new server
state: `progress.all(profile.id)` is already fetched on every shelf render and
already knows which books have a position.

### 8. A page per book

`Book.description` is parsed by the sync tool, written into `metadata.json`,
copied into the catalog, shipped to the browser — and never rendered. There is
no route where a book's own details live; `/read/<key>` is the only per-book
page, and it is the reader.

`/book/<id>` — description, every field the metadata carries, formats with
sizes, a large cover, reading position, and the download and read actions the
shelf row currently crowds together. It is also the page that should own the
OpenGraph metadata that `read/[...key]/page.tsx` currently generates while
asking not to be indexed. Note that `/book/[...path]` is taken by the EPUB
entry route, so this wants `/books/<id>` or a rename of that route.

### 9. Sorting, filtering, and a shelf that scales

`catalog.search()` is a case-insensitive substring test across title, authors
and publisher. No sorting but alphabetical, no filters, no diacritic folding
(so `Bronte` does not find `Brontë`), no ranking (so a title match sorts below
an author match), and no pagination — every book renders every time.

In rough order: sort by title, author, date added and recently read; filter by
format, language, author and the new `subjects`; fold diacritics through the
`NFKD` normalisation `slugify` already uses; rank exact-prefix title matches
first. Then pagination or a virtualized list, because the shelf's real limit
today is the DOM rather than the catalog.

`CatalogService` holds the whole catalog in the isolate and reads it once a
minute, which is right for hundreds of books and wrong for tens of thousands.
When that becomes the binding constraint, the answer is a generated index —
sharded JSON, or D1 for an R2 deployment — behind the same
`CatalogService` interface, not a change to the pages.

### 10. Reading on a phone

The reader turns pages with two small buttons and the arrow keys. On a
touchscreen that is most of what there is: no swipe, no tap zones, no way to
reach the chrome without hitting a 32-pixel target.

Swipe left and right, tap the left and right thirds to turn, tap the middle to
show and hide the chrome, and an immersive mode that gets the header out of the
way. `allowScriptedContent: false` means the touch listeners go on the
`rendition`, which re-emits events from inside the iframe the same way it does
`keydown` today. Also worth the keyboard equivalents while in there — space,
`PageUp`/`PageDown`, `Home`/`End`.

### 11. Bookmarks, and then highlights

A CFI names a range as precisely as it names a point, which is what makes both
of these the same feature twice. `epub.js` renders them through
`rendition.annotations`.

It needs a state file — `.bookshelf/annotations/<profileId>.json`, alongside
`progress/`, which `isStateKey` already protects from a `--force` — and it
should degrade the way progress does: a read-only library keeps them in the
browser and says so. Bookmarks first; highlights and notes are the same
storage with a colour and a body.

### 12. Search inside a book

`book.spine.each` plus `section.find(query)` gives full-text search across a
book with no server involvement, at the cost of fetching each section once.
Results as a list of excerpts, each a CFI to jump to. For a technical library
this is closer to essential than to nice, and it is a contained piece of work.

## Later

Interop and scale — bigger, and each one arguably a project of its own.

### 13. An OPDS feed

One route serving OPDS 1.2 (Atom) or 2.0 (JSON) turns the library into
something KOReader, Moon+ Reader, Panels, Thorium and Calibre can all browse
and download from directly. For anyone reading on e-ink hardware, this is worth
more than every reader improvement above it, because the reader on that device
is already better than a browser can be.

The catalog is already the right shape; it is a serialization plus paging,
faceted by author and subject once **#9** produces those. It shares the
authentication question with **#4** — OPDS clients do HTTP Basic, not an
identity provider, which likely means scoped tokens.

### 14. More formats than EPUB and PDF

`BOOK_EXTENSIONS` in `packages/sync/src/lib/config.ts` is two entries, and it is
the only place that decides what a book can be. Each addition is a reader in
the app plus a metadata reader in the sync tool:

- **CBZ** — a ZIP of images, so `packages/core/src/zip.ts` already reads it,
  and the "cover" is the first entry. A page-at-a-time comic reader is a
  smaller piece of work than either reader that exists.
- **MOBI/AZW3** — PalmDB and KF8, worth it because it is what a decade of
  Kindle libraries are stored as. Convert on publish rather than render:
  extract metadata and cover, and offer the EPUB conversion as the readable
  format.
- **FB2**, **DjVu**, **plain text** and **Markdown** — each straightforward,
  each niche, and each better as a contribution than as a plan.

### 15. Publishing that knows what changed

`buildLibrary` deletes the output tree and rebuilds it whole on every run: it
re-reads every EPUB, re-renders every PDF cover, and re-thumbnails everything,
then `syncLibrary` compares against the destination to decide what to upload.
The comment explains why — a removed book must not linger — and that reasoning
is sound, but it means a library of a thousand books costs a full rebuild to
add one.

Keep the rebuild-from-scratch semantics and add a build cache keyed by source
path, size, mtime and content hash, so an unchanged book is re-linked rather
than re-parsed. Then:

- **Metadata overrides** — a `<book>.json` beside the file, or an `overrides/`
  directory in the library, so a wrong title can be fixed without editing the
  EPUB and without the fix being erased by the next sync. Currently the only
  way to correct anything is to rename the file.
- **`--only <glob>`**, to publish one book while iterating.
- **A dry-run diff** that says what would change rather than what would be
  built.

### 16. Adding books from the browser

Every path into the library goes through the CLI on a machine with the books on
it. `Storage.write` exists and is used for profiles and positions, so an upload
route is mechanically possible — but the metadata reading, the cover
rasterising and the thumbnailing all shell out to `pdftoppm` and `cwebp`, which
do not exist in a Worker.

Which makes this a real design question rather than a feature: either the FS
provider's Node server grows an upload path and the Worker does not, or cover
generation moves to WebAssembly, or an upload is accepted unprocessed and a
later sync fills in the rest. Worth deciding before building.

### 17. Offline reading

`manifest.ts` makes it installable; nothing makes it work on a plane. A service
worker plus explicit "keep this book on this device" — the archive, the cover,
the catalog row — and positions that queue while offline and flush on
reconnect. The reader already writes to `localStorage` before the network, so
the position half is closer than it looks.

## Someday

Ideas worth keeping, none of them load-bearing.

- **Reading statistics** — time read, books finished, pace. Needs a session
  concept the app does not have, and a finished state, which is really
  `progress >= 99%` plus a manual override.
- **Collections** — hand-made shelves alongside the automatic ones from
  `series` and `subjects`. Per library or per profile is the design question.
- **Send to device** — email an EPUB to a Kindle address, or a QR code from
  the book page to open it on a phone. The second is nearly free.
- **Two devices, one profile** — currently last-write-wins, which the README
  lists as a known limitation. Merging positions properly means recording which
  device wrote one.
- **A conversion pipeline** — EPUB from PDF, EPUB from MOBI. Big, and probably
  a job for whatever runs **#16**'s processing.
- **Interface localization**, and a shelf that groups by the language its books
  are actually in.
- **Accessibility beyond the basics** — the reader's iframe needs deliberate
  focus management, live-region announcements on page turns, and a keyboard
  shortcut sheet. Some of this arrives with **#10**.

## Not planned

Worth stating, so that each is a decision rather than an omission.

- **A user-facing metadata editor.** The library is regenerable by design
  (`docs/library-format.md`); the editable thing is the source book or an
  override file, not the published catalog.
- **Fetching metadata from the internet.** Google Books and OpenLibrary would
  fill in what a file lacks, and would also make `sync` depend on a network and
  on someone else's uptime. If it happens, it is opt-in, cached, and never on
  the default path.
- **Social features.** Not what this is.
