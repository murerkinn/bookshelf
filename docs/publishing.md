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
