# The demo library

The public instance serves books from [Project Gutenberg](https://www.gutenberg.org),
which is what lets it be public at all. `tools/gutenberg.mjs` holds the list —
ids, not files, because 22 MB of EPUBs do not belong in a repository and a list
can be re-fetched.

```bash
npm run demo:gutenberg     # fetch them into gutenberg/
```

It is resumable: books already there are skipped, so a failed run costs only
what it did not finish. Requests go out one at a time, because this is somebody
else's bandwidth.

## Why the no-images edition

Gutenberg offers an illustrated EPUB and a plain one. The plain one still
carries a cover, which is what the shelf wants, at around 500 KB against 25 MB
for the same text. Fifty-six books come to 22 MB rather than a gigabyte.

## Publishing it

Point the config at the fetched books and publish as usual:

```jsonc
{ "input": "gutenberg", "output": "demo-library", "storage": { ... } }
```

`--force` replaces whatever the last catalog recorded, so the demo shelf is
exactly this list and nothing that came before it. Reading positions and
profiles survive: providers leave `.bookshelf/` out of what they enumerate.

## What the dates mean

The year on the shelf is the book's own `dc:date`, and for Gutenberg that is
the release date of the digital edition — so *Pride and Prejudice* reads 1998.
Every library here is described by what its books say about themselves rather
than by anything guessed or overridden, and the demo is not an exception to
that. It reads oddly; the alternative reads wrongly.

## Keeping it read-only

A public shelf that anyone can rewrite is not much of a demonstration by the
second visitor. The instance runs with `BOOKSHELF_READ_ONLY=1` — see
[the README](../README.md#a-public-instance).

## Licensing

The files are served as Gutenberg published them, including the licence header
each one carries. Nothing here strips or repackages them.
