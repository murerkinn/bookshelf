# Roadmap

What is missing, roughly in the order it is worth doing. Each entry says what
the code does today, what it should do, and which files carry the change — so
that picking one up does not start with a re-reading of the repository.

Priority here means *how much of the project is incomplete without it*, not how
interesting it is. A library that can hold PDFs but cannot read a PDF's title
is unfinished in a way that a library without annotations is not.

## Now

The five things that left a visible hole in what was already shipped. Four are
done; **#4** is the one still open, and it is the one that decides whether an
instance can be put where strangers can reach it.

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

### 2. A real PDF reader — **done**

`apps/bookshelf/src/app/read/[...key]/page.tsx` used to hand anything that was
not an EPUB to an `<iframe>` pointed at `/download/<key>?inline=1`. The browser's
viewer is good, but the whole of the reader's behaviour was lost with it: no
saved position, so **Continue** never appeared for a PDF; no contents; no layout
choice; a full download before the first page; and on iOS Safari an inline PDF in
an iframe renders one page and stops.

What landed, on pdf.js, in `read/[...key]/`:

- **`position.ts`** — the part **#5** said was worth reusing rather than
  rebuilding, now extracted from `epub-reader.tsx` and used by both: browser copy
  first, newest-wins reconciliation on the way in, a four-second debounce out to
  the library, and a `sendBeacon` flush on `pagehide`. Both readers went through
  it before either was trusted with it.
- **`pdf-reader.tsx`** — three layouts in the same vocabulary the EPUB reader
  uses (two pages, one page, scroll), zoom with a capped automatic default,
  paper/sepia/night, a page box that is somewhere to go as well as something to
  read, keyboard and swipe, and a progress line.
- **`pdf-page.tsx`** — one page. Every page is a box of the right shape whether
  or not it has been drawn, so a five-hundred-page document has a real scrollbar
  from the moment it opens and only the pages near the reader cost anything.
  Drawing goes to an off-screen canvas and is blitted in, because assigning a
  canvas's width clears it and a zoom would otherwise blank the page.
- **`pdf-sidebar.tsx`** — contents and search, in a drawer. The plan here said
  the outline should fill the same dropdown the EPUB reader uses; it should not.
  A technical PDF's outline runs to hundreds of entries, which is a column of
  text rather than a `<select>`, and search wants the same shape. The header and
  the toolbar are still one idiom across both readers.
- **`pdf-search.ts`** and the matching half of **`pdf-document.ts`** — **#12**,
  arriving early because for a PDF it is contained: the text is already coming to
  the browser to be drawn. Case and accents folded, whitespace collapsed, and an
  offset map back to the original so an excerpt is shown as it was written and
  cut at a word. Marked with `CSS.highlights`, which does not need the runs to be
  split and so does not move the words inside them.
- **`BookProgress`** in `packages/core/src/state.ts` grew an optional
  `page?: number`, flat beside `cfi` and `href` rather than as a discriminated
  union, so the file on disk is unchanged for every book already in a library.
  `STATE_VERSION` did not move: a reader that meets a kind of position it does not
  understand starts at the beginning, which is what it already did for a book
  nobody had opened. The shelf needed no change at all — **Continue** is drawn
  from a position existing, not from what kind it is.
- **`scripts/pdfjs-assets.ts`** and an `assets` task — pdf.js asks for its
  worker, its CMaps, its standard fonts and its wasm by URL at the moment it
  needs them, which no bundler sees. Copied out of the package rather than
  committed, and stamped with the version they came from so a second run is free.
- Fixtures: **`bookPdf`** in `@bookshelf/fixtures`, which is a document rather
  than the smallest file that exercises one quirk — pages with content streams,
  fonts, an outline, and metadata in both of the places a PDF keeps it. The demo
  shelf now has a PDF on it, so the other reader is one click from a screenshot
  instead of reachable only by URL. Page text is WinAnsi-encoded, because a
  `/WinAnsiEncoding` font reads a content stream a byte at a time and an em dash
  written as UTF-8 is drawn as three characters.

Ranges from **#3** are what make it worth having: `disableAutoFetch` off, and a
40 MB book opens on a few 128 KB reads instead of on all of it. Verified in a
browser against a 359-page document — ranged loading, text selection across
runs, the outline, search, all three layouts, and a position that survives a
reload and puts **Continue** on the shelf.

What was deliberately left: page thumbnails, tap zones (a swipe works), and
rotating a page that was scanned sideways. And one thing that cannot be helped —
pdf.js opens with a request for the whole file which it aborts once it has read
`Accept-Ranges` off the headers, because there is no way to tell it the length in
advance. It shows in a network log as a cancelled request that transferred
almost nothing.

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

Authentication answers *who*. There is a second question it does not touch,
which is *how much*. Nothing bounds what one caller can cost: `/download/`
serves whole books and answers ranged requests, so an instance on the open
internet is a tap that a loop with `curl` can open. R2 charges nothing for
egress, which takes the sting out of the bill but not out of the count — every
range is a Class B operation and a Worker invocation. The shelf itself is
cheap, because the catalog is memoised and the covers carry a day; the books
are not.

That is configuration rather than code, and it differs by deployment, so what
it needs is a page rather than a module:

- **Cloudflare** has the mechanism already: a rate-limiting rule on `/download/`
  and `/book/`, and a WAF rule for whatever is not a browser. Worth writing down
  with numbers in it, since "add a rate limit" is not advice anyone can act on.
- **A reverse proxy** — `limit_req` in nginx, `rate_limit` in Caddy — for the
  Docker and VPS cases, in the same place TLS termination already lives.

Neither belongs in the app, and for the same reason in both: a limit enforced
inside the Worker has already paid for the request that reached it.

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

Half of this is done, on the PDF side: **#2** brought paper, sepia and night to
`pdf-reader.tsx`, where a tint is a filter over the drawing because a PDF's page
is a picture. An EPUB's chapter is markup, so it gets the better version of the
same feature and none of the code.

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

A PDF has this now — a page of a total, and a progress line along the bottom —
because a page number is a position a document already knows. An EPUB has to be
measured first, which is what the rest of this entry is about.

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

"Date added" is the one of those that needs a field rather than a comparator.
Nothing in `Book` records when a book arrived — `catalog.json` carries one
`generatedAt` for the whole library, which is what **#13** dates every OPDS
entry by for want of anything better. An `addedAt` written by
`packages/sync/src/lib/build.ts`, preserved across republishes rather than
stamped afresh, is a `CATALOG_VERSION` bump that pays for itself twice: this
sort, and a "Recently added" feed in the catalog.

`slugify` is also worth hoisting out of `build.ts` into `packages/core` while
the diacritic folding is being written, since both want the same
normalisation — and the OPDS catalog puts names in paths unslugged today
partly because that helper was not reachable from the app.

`CatalogService` holds the whole catalog in the isolate and reads it once a
minute, which is right for hundreds of books and wrong for tens of thousands.
When that becomes the binding constraint, the answer is a generated index —
sharded JSON, or D1 for an R2 deployment — behind the same
`CatalogService` interface, not a change to the pages.

### 10. Reading on a phone

The PDF reader takes a swipe and the full set of keys; what it does not have is
tap zones or an immersive mode, and the EPUB reader has none of it.

The EPUB reader turns pages with two small buttons and the arrow keys. On a
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

Done for PDF, as part of **#2**: `pdf-search.ts` scans the document a page at a
time, streams results in, and marks them with `CSS.highlights`. What remains is
the EPUB half, and the folding and excerpt-cutting in `pdf-document.ts` is
reusable rather than rewritten.

`book.spine.each` plus `section.find(query)` gives full-text search across a
book with no server involvement, at the cost of fetching each section once.
Results as a list of excerpts, each a CFI to jump to. For a technical library
this is closer to essential than to nice, and it is a contained piece of work.

## Later

Interop, scale, and one change of shape — bigger, and each one arguably a
project of its own. **#13** is done; the rest are not.

### 13. An OPDS feed — **done**

The library was reachable by a browser and by nothing else. For anyone reading
on e-ink hardware that was the wrong way round, because the reader on that
device is already better than a browser can be.

What landed — `/opds`, both versions, in `apps/bookshelf/src/lib/opds/`:

- **OPDS 1.2 (Atom) and 2.0 (JSON) from one model.** `feed.ts` is shaped after
  2.0, the more general of the two, which leaves `atom.ts` as a translation step
  rather than a second model and `json.ts` as little more than dropping the
  fields a book does not have. Both use the same
  `http://opds-spec.org/acquisition/*` relations, so the projection from a book
  to its links is written once. Which version a request gets is negotiated from
  `Accept`, with `?format=` to force it — and a JSON feed stamps `format=json`
  on every link to another feed, so a client that sends a wildcard `Accept` on
  its next request is not handed Atom halfway through browsing.
- **A navigation root with browse axes**, not one flat list: all books, by
  author, by subject, by series, each with a count, and an axis nothing is filed
  under is not offered at all. The groupings in `browse.ts` are `Map`
  operations over the array the catalog already holds in the isolate, so they
  needed none of the generated index **#9** will want — which is the one thing
  this entry expected to depend on and did not.
- **Search**, reusing the shelf's own predicate rather than restating what a
  query matches. It moved out of `CatalogService` as `searchBooks`, which both
  the shelf and the feed now call, so the two cannot disagree. 1.2 gets an
  OpenSearch description document, 2.0 the templated link it requires, which is
  why `/opds/books` answers to `query` as well as `q`.
- **Paging** at fifty to a page, `first`/`previous`/`next`/`last`, the query
  carried along, and page one as the feed itself rather than `?page=1`.
- **A weak ETag over the catalog date, the URL and the format** rather than over
  the body — so a client refreshing a feed it already holds gets a 304 without
  the server building the feed to find out.
- **Names in paths, percent-encoded rather than slugged.** They round-trip
  exactly, so nothing keeps a table mapping one back to the other, and two
  authors who would slug the same stay two authors. `slugify` stayed private to
  the sync tool; hoisting it to core is **#9**'s business.

Two structural notes worth having written down. One route, `[[...path]]`, owns
the whole space, because the serializers already have to generate every URL in
it to write their links and a second copy in the filesystem is a copy that can
drift. And nothing under `lib/opds/` reads `next/headers` — `serveOpds` takes
the shelf and the origin as parameters — which is what puts every feed inside
`test/opds.test.ts`, where each one is parsed rather than pattern-matched.
`siteOrigin()` moved to `lib/origin.ts` to keep it that way: a request-scoped
function and the site's name are different things, and only one of them needs a
request around it.

Two things it does **not** do, both deliberate:

- **No authentication.** It ships as open as the rest of the app, because
  `/download/` already serves every book with no credential. What the feed adds
  is enumeration rather than access, which is worth saying out loud and is said
  out loud, in `docs/opds.md` and in the README. **#4** is where this gets
  fixed, and OPDS is the strongest argument for doing it: clients do HTTP Basic
  rather than an identity provider, which is what points that entry at scoped
  tokens.
- **No "Recently added."** Every entry is dated by `catalog.json`'s
  `generatedAt`, which the app had never read until now, because it is the only
  timestamp a library has. Harmless for OPDS, where clients re-list rather than
  diff. The fix is an `addedAt` on `Book`, folded into **#9** below, which wants
  the same field to sort by.

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

One thing has to land with it whichever way that goes. `readZipEntry` inflates
an entry through `DecompressionStream` and believes the size the directory
claims; nothing caps what comes out. Every archive the reader has ever been
handed was put there by whoever runs the instance, so today that is a statement
about trust rather than a hole — and an upload route is precisely the change
that stops it being true. A few kilobytes that inflate to a few gigabytes is a
ZIP's oldest trick, and in a Worker it is an isolate that dies rather than a
request that fails. The cap belongs in `packages/core/src/zip.ts` beside the
Zip64 refusal, which is already where that file decides an archive is more than
it will take on.

### 17. Offline reading

`manifest.ts` makes it installable; nothing makes it work on a plane. A service
worker plus explicit "keep this book on this device" — the archive, the cover,
the catalog row — and positions that queue while offline and flush on
reconnect. The reader already writes to `localStorage` before the network, so
the position half is closer than it looks.

### 18. A library the server cannot read

Everything published is in the clear: the books, the covers, `catalog.json`, and
the object keys, which are slugified titles and so name every book to anything
that can list the bucket. What that fails to answer is not an attacker so much
as the ordinary situation of keeping a media library on hardware belonging to
somebody else. A bucket accidentally made public exposes all of it at once, a
provider may scan what it stores, and a request served on the provider does not
involve you at all.

Encrypting it moves the trust boundary rather than adding a feature. Inside it:
the sync tool, which runs on the operator's own machine, and the browser.
Outside it: storage, and the app. The Worker becomes a pipe that hands out
ciphertext and never holds a key.

What that costs, which is most of the work:

- **The shelf stops being server-rendered.** `page.tsx` renders `catalog.json`
  and `CatalogService.search()` greps it in the isolate. Against a ciphertext
  catalog both move into the browser — fine for hundreds of books, and exactly
  the scale **#9** already describes for tens of thousands.
- **`/book/[...path]` goes.** Reading one chapter out of an archive on two
  ranged reads is the thing `docs/reader.md` is proudest of, and all of it is
  server-side ZIP reading. The archive has to be opened in the browser instead.
- **A cover stops being an `<img src>`.** A service worker that decrypts
  `/cover/` keeps both the tag and the HTTP caching of the ciphertext; blob URLs
  are the cruder way.
- **Keys stop being names.** A slug names its book, so folder names become
  HMACs — which changes the library format and the publish diff in `bucket.ts`.

What keeps it from being a rewrite: the ZIP and PDF readers in `packages/core`
are written against `ByteSource` and decompress through `DecompressionStream`
rather than `node:zlib`, so both already run in a browser unchanged. Moving the
unwrapping to the client is mostly a re-wiring of the composition root.

Ranges have to survive, and that is the part which decides whether the readers
regress. Encrypt in fixed-size chunks with a nonce each, map a byte range onto a
chunk range, and a `PDFDataRangeTransport` that fetches and decrypts chunks
keeps the 40 MB book that opens on a few 128 KB reads. Skip it and every format
degrades to downloading the whole book before the first page — which is the
behaviour **#2** and **#3** existed to remove.

Keys: a passphrase through PBKDF2, which WebCrypto has and Argon2id would need
WebAssembly for, wrapping a content key per file, with the salt and a
verification blob in a `.bookshelf/vault.json` the CLI writes. The shape of
Cryptomator's masterkey file, for the same reasons it has that shape.

Two things worth saying out loud rather than discovering afterwards. The Worker
serves the JavaScript that does the decryption, so this is trust-on-first-load
the way every browser-delivered crypto app is: a real defence against the
storage provider, a bucket left open, and a request served on the provider — and
no defence at all against a compromised app host. It is strongest in the
deployment where the operator runs the app and only the storage belongs to
somebody else. And it is not authentication. It makes a stranger's GET return
ciphertext, which is a different question from **#4**'s and does not answer it.

It also argues with what is already planned. **#13** cannot work in an encrypted
library, because KOReader cannot decrypt — so the two are modes rather than
features, and the choice has to be named somewhere. **#16** gets harder in the
same way cover generation already makes it hard.

Available today, and worth documenting rather than building: `directory` is a
path, so a gocryptfs or Cryptomator mount holds an encrypted library with no
code at all — see
[the filesystem provider](providers/fs.md#encrypting-the-directory). It protects
a stolen disk and a curious host; it does nothing for R2, and nothing against
the machine that is serving the library while the mount is open.

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
