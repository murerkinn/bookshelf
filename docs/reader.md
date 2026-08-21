# Reading in the browser

![The reader: a two-page spread of a chapter, with a contents dropdown and a layout selector](reader.webp)

Every book has a **Read** link. PDFs go straight to the browser's own viewer,
served with an inline disposition rather than as a download.

EPUB has no native support, so it is rendered by epub.js — but pointed at the
book's package document rather than the `.epub` itself. That matters: given a
`.epub` URL, epub.js downloads the whole archive before showing page one, which
for this library would mean 8 MB typical and 42 MB worst case. Given the `.opf`,
it fetches chapters one at a time from `/book/<key>/<entry>`, which reads that
one file out of the archive in R2 using ranged requests.

Two things keep it quick. Each entry is fetched in **one** ranged read rather
than two — the local header sits in front of the data at an offset the central
directory doesn't record, so the read covers header and data together and parses
the header back out. And a book opens at its first real section rather than its
cover. Together those take a cold open from 1,755 KB to 73 KB. Continuous scroll
is the exception at around 1.3 MB, because it starts at the top of the book and
so does render that cover.

Book markup is untrusted, so the reader renders it in an iframe sandboxed
without `allow-scripts`, and entry responses carry a `sandbox` CSP for anyone
who opens one of those URLs directly.

Reading position is kept in `localStorage` per book — per device, so it does not
follow you between them. Layout is a choice of two pages, one page, or
continuous scroll, remembered across books.
