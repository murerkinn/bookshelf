# Reading in the browser

![The reader: a two-page spread of a chapter, with a contents dropdown and a layout selector](reader.webp)

Every book has a **Read** link. PDFs go straight to the browser's own viewer,
served with an inline disposition rather than as a download — and over
[ranged requests](#ranges), so a viewer that fetches page by page is not made to
download the whole book to show the first one.

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

## Ranges

`/download/<key>` advertises `Accept-Ranges: bytes` and answers a `Range` with a
`206` naming exactly what it served. That is what lets the browser's PDF viewer
ask for the part of a file it is showing, and it is the same saving the EPUB
reader gets by reading one entry out of an archive — except the client does the
asking rather than the server working it out.

It also makes a download resumable. An interrupted transfer continues from where
it stopped, guarded by `If-Range`: a client says which version it holds part of,
and if the book has been republished since — which happens at the same key — the
range is declined and the whole of the new file is sent, rather than two
different files being spliced together.

A single range is honoured. A request for several at once is answered with the
whole object, which is allowed, and avoids assembling a `multipart/byteranges`
body that nothing reading this library asks for.

Note that responses come back `Transfer-Encoding: chunked` without a
`Content-Length`: workerd streams a body of unstated length that way. The extent
of a partial response is in its `Content-Range` regardless, but a browser's
download UI has no total to show a percentage against.

Reading position is kept in `localStorage` per book — per device, so it does not
follow you between them. Layout is a choice of two pages, one page, or
continuous scroll, remembered across books.
