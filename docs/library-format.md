# The library format

What the sync tool writes, so you know what you're backing up and what you can
safely change.

## The layout

One folder per book, plus a generated catalog:

```
library/
  the-time-machine/
    metadata.json          what the book says about itself
    cover.webp
    the-time-machine.epub
    the-time-machine.pdf   any number of formats
  catalog.json             generated from every metadata.json
  .bookshelf/              written by the app, not the sync tool
    profiles.json
    progress/<profile>.json
```

Folder names are slugified titles, so a listing of your storage names your
shelf.

## metadata.json

Holds what the book records about itself: title, authors, publisher, date,
language, identifier, ISBN, description, subjects, series, and a page count for
formats that have one.

Only the title is required. A book that doesn't record a publisher or a date is
normal, not broken. For how each format stores this and how far it's trusted,
see [publishing](publishing.md#what-ends-up-on-your-shelf).

## catalog.json

Generated from every `metadata.json` in the library. Delete it and the next
`npm run sync` writes it again.

## .bookshelf/

Your profiles and reading positions. This is the only thing in the library the
sync tool didn't put there, and it never removes it — not on a normal run, not
with `--force`.

## What to back up

Back up your books, and back up `.bookshelf/`.

Everything else regenerates. If you lose the library but still have your
original files, `npm run sync` rebuilds all of it. If you lose `.bookshelf/`,
everyone's reading positions are gone.
