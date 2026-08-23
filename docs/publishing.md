# Publishing a library

The sync tool reads a folder of books, builds a library from what the books say about themselves, and uploads it through a provider.

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

Everything under `storage` except `provider` belongs to the provider and is
passed to it untouched — the CLI does not know what any of those keys mean. What
each one accepts is on its own page: [R2](providers/r2.md),
[filesystem](providers/fs.md).

The script reads each book once for its metadata and its cover, groups files
sharing a name into one book with several formats, and hard-links book files
into the tree, so publishing 763 MB of books costs about a megabyte of disk.
What it reads out of a book, and how much of it to believe, is
[metadata](#metadata) below.

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

## Metadata

Both formats are read, and neither is trusted very far.

An **EPUB** keeps Dublin Core in its package document, and it is usually right:
title, authors, publisher, date, language, identifier, description, subjects,
and a series where Calibre or an EPUB 3 collection recorded one.

A **PDF** records the same things in two places and agrees with itself only
sometimes. The XMP packet is Dublin Core and can hold a list where the older
information dictionary holds one string — three authors as three authors rather
than as one field with semicolons in it — so XMP is read first and the
dictionary fills in field by field. A page count comes from the page tree.

Neither half is authoritative about the title, so both are tried in turn and the
first plausible one wins. PDF writers fill that field in with whatever is to
hand:

| recorded title | what happens |
| --- | --- |
| `Cloudflare DPA v6.4.docx` | rejected: a file name with its extension |
| `Microsoft Word - contract.doc` | rejected: the program's doing |
| `untitled`, `Slide 1`, blank | rejected: says nothing |
| `resumepages`, for `resumepages.pdf` | rejected: the file's own name |
| `Skia/PDF m149`, where that is also the producer | rejected: the tool's name |
| `coyotiv-brochure-v1.3-web` | **kept** — ugly, but it is what the document calls itself |

A rejected title falls through to the next place it might be recorded, and then
to the file name — which is where a title came from before any of this, so the
worst case is what used to be the only case.

Two things a PDF does not really have. Its **creation date** is when the *file*
was written, which for a scan or a re-export is not when the book came out; it
is published as the date only, since a second's precision about the wrong event
is not worth keeping. And an **ISBN** is only recorded when a candidate's check
digit is valid, because an identifier field holds whatever the publisher put
there and an unverified ten-digit run would turn an internal catalogue number
into an ISBN that nothing downstream could tell was invented.

An **encrypted PDF** is the one case where metadata is missing for a reason
rather than absent. The permissions-only encryption publishers apply leaves the
structure readable and the strings ciphertext, and there is no decryption here,
so nothing is reported rather than mojibake. `sync` marks those books
`[encrypted, no metadata]`; they still publish, and still get a cover, because
rendering the first page does not go through this reader.

## Covers

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

The Docker image ships both, so nothing needs installing on that route.

## Where it runs

```
packages/sync/src/
  sync.ts            the CLI
  lib/
    config.ts        bookshelf.config.json, resolved
    epub.ts          metadata and cover extraction, from the package document
    pdf.ts           metadata extraction, from XMP and the info dictionary
    metadata.ts      the parts of that both formats share
    images.ts        thumbnailing, and PDF first-page rendering
    build.ts         builds library/
    bucket.ts        works out what to upload and what to remove
    providers.ts     resolves a provider by importing its package
    util.ts          a worker pool, retries, and reading an unknown error
```

Built to `dist/` with `tsc`, like the other packages — so `npm run sync` compiles
it first, and `npm run check-types` covers it.
