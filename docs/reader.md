# Reading in the browser

![The reader: a two-page spread of a chapter, with a contents dropdown and a layout selector](reader.webp)

Every book on your shelf has a **Read** link. EPUBs and PDFs each get a reader
built for them; anything else opens in your browser's own viewer.

Books open where you left off, and the **Continue** button on the shelf takes
you straight back to the one you're part-way through.

## Controls

Both readers share the same controls.

| | |
| --- | --- |
| **Layout** | two pages, one page, or continuous scroll |
| **Contents** | jump to a chapter or a bookmark |
| **Page tint** | paper, sepia or night |
| **Download** | the file itself |

**Keyboard**, in the page-at-a-time layouts:

| | |
| --- | --- |
| arrows, page up / page down | turn the page |
| space, shift-space | turn the page |
| Home, End | the start or end of the book |

In continuous scroll the arrows scroll instead of turning. On a touchscreen,
swipe to turn.

## PDFs

**Zoom** is automatic by default: fitted to the width of your window, but never
past 125%, because a Letter page blown up to fill a wide monitor sets the body
text at about twenty-four points. Fit-width, fit-page and fixed percentages are
all available.

**Search** works over the whole document and runs entirely in your browser.
Results stream in as pages are scanned, and the first search costs one pass over
the document — after that it's instant. Matching ignores case and accents, so
`Bronte` finds `Brontë`, and it matches across line breaks.

**Contents** comes from the document's own outline, in a drawer rather than a
dropdown, because technical books run to hundreds of bookmarks.

**Page tint on a PDF is a filter over the page**, not a restyling. A PDF page is
a picture, background and all, so tinting can't work the way it does for an
EPUB. It looks right for text and diagrams and wrong for photographs, which is
why paper is the default.

**You can select and copy text**, and screen readers can read the page, because
the text sits over the page as a transparent layer.

Not there yet: page thumbnails, tap zones for turning on a touchscreen, and
rotating a page that was scanned sideways.

## Opening a big book is cheap

You don't download the whole file to start reading. A 40 MB PDF opens on a few
128 KB reads and the rest arrives as you read. An EPUB fetches one chapter at a
time — a cold open costs about 73 KB rather than the whole archive.

Continuous scroll on an EPUB is the exception, at around 1.3 MB, because it
starts at the top of the book and renders the cover.

If you're watching a network log, you'll see the PDF reader make one request for
the whole file and immediately cancel it. That's how it discovers that ranged
requests are available. It transfers almost nothing.

## Downloads resume

An interrupted download continues from where it stopped rather than starting
again. If the book was republished in the meantime, you get the whole of the new
file instead of two halves spliced together.

Your browser may not show a percentage while downloading. The server streams
book files without stating a total length up front, so there's nothing for the
progress bar to count against.

## Where your place is kept

Your position is written to your browser first, so you never lose it to a bad
connection, and saved to the library a few seconds later. Closing the tab
flushes whatever is outstanding.

Which file it's saved to depends on [which profile](profiles.md) is reading. On
a library the app can't write to, positions stay in your browser only.

Layout, zoom and tint are remembered per device rather than per profile.
