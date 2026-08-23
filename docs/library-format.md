# The library format

What the sync tool publishes, and what the app may assume about it. Both sides read the shape from `@bookshelf/core`, so neither can drift.

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
publisher, date, language, identifier, ISBN, description, subjects, series, and
for a fixed-page format a page count — read out of the book rather than guessed
from a file name. Every field but the title is optional, because a book that
does not record something is the normal case rather than an error; see
[metadata](publishing.md#metadata) for where each format keeps it and how far it
is believed. `catalog.json` is only the concatenation of them, so it can be
regenerated, or swapped for a different format entirely, without touching the
library.

`.bookshelf/` is the one thing here the sync tool did not put there, and so
the one thing it must never take away — see [profiles](profiles.md).
