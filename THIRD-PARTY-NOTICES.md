# Third-party notices

Bookshelf is MIT — see [LICENSE](LICENSE). That covers the code in this
repository. It doesn't cover the other people's code that ships alongside it,
which is what this file is for.

If you redistribute the app or the Docker image, these are the terms you're
passing on. They're listed separately because the two artifacts carry different
obligations.

Nothing here says anything about the books you put in a library built with this.
Those are between you and their publishers.

## In the app

Bundled into the Worker, or served by the Node server:

| | |
| --- | --- |
| [Next.js](https://github.com/vercel/next.js) | MIT |
| [React](https://github.com/facebook/react) and React DOM | MIT |
| [OpenNext for Cloudflare](https://github.com/opennextjs/opennextjs-cloudflare) | MIT |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | Apache-2.0 |
| [epub.js](https://github.com/futurepress/epub.js) | BSD-2-Clause |
| [JSZip](https://github.com/Stuk/jszip) | MIT or GPL-3.0-or-later, at your option — reached through epub.js, taken here under MIT |
| [Lucide](https://github.com/lucide-icons/lucide) (`lucide-react`) | ISC |
| [xmldom](https://github.com/xmldom/xmldom) (`@xmldom/xmldom`) | MIT |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 — an optional dependency of Next.js, used for image optimisation |
| [libvips](https://github.com/libvips/libvips) | LGPL-3.0-or-later — the prebuilt library sharp loads, shipped as `@img/sharp-libvips-*` |

The Apache-2.0 text is at <https://www.apache.org/licenses/LICENSE-2.0>, the
LGPL-3.0 text at <https://www.gnu.org/licenses/lgpl-3.0.html>.

libvips is the only one with a condition beyond attribution. sharp loads it
dynamically rather than linking it into anything, which satisfies LGPL-3.0 §4 by
leaving it replaceable — it arrives as its own npm package and you can swap it
for another build of the same library. Its source is at the URL above. If you
ship a modified libvips with this app, you owe that modified source.

## pdf.js runtime files

`apps/bookshelf/scripts/pdfjs-assets.ts` copies part of `pdfjs-dist` into
`apps/bookshelf/public/pdfjs/` when you build, because pdf.js fetches those
files by URL and no bundler sees the request. They aren't vendored — the
directory is gitignored and regenerated from whichever `pdfjs-dist` is
installed.

The copy is recursive, so each directory's own license file comes with it:

| | |
| --- | --- |
| `pdf.worker.min.mjs` | Apache-2.0, Mozilla Foundation — the notice is in the file's own header |
| `cmaps/` | BSD-3-Clause, Adobe Systems — `cmaps/LICENSE` |
| `standard_fonts/` | BSD-3-Clause (PDFium/Foxit) and the SIL Open Font License (Liberation) — `LICENSE_FOXIT`, `LICENSE_LIBERATION` |
| `wasm/` | BSD-3-Clause (PDFium, JBIG2), BSD-2-Clause (OpenJPEG), MIT (qcms) — `LICENSE_JBIG2`, `LICENSE_OPENJPEG`, `LICENSE_QCMS` |
| `iccs/` | CC0-1.0 — `iccs/LICENSE` |

If you serve `public/pdfjs/`, you're serving those license files with it. Don't
strip them.

## In the Docker image

The image adds three things to the app.

**`node:24-slim`**, the base: Node.js under MIT, on Debian. Every package in the
base carries its copyright and license under `/usr/share/doc/*/copyright` inside
the image, which is the authoritative list for that layer.

**poppler-utils**, GPL-2.0-or-later. `pdftoppm` renders a PDF's first page as a
cover. Source: <https://poppler.freedesktop.org/>, and Debian's exact build with
`apt-get source poppler-utils` against the image's own sources. Treat this as
the offer under GPL-2.0 §3(b) if you received the image from us; if you
redistribute it, you take on the same obligation.

**webp**, BSD-3-Clause. `cwebp` thumbnails covers. Source:
<https://chromium.googlesource.com/webm/libwebp>.

Both are run as separate processes — the sync tool passes paths on a command
line and reads the exit code. Nothing links against them, so shelling out to
`pdftoppm` does not make Bookshelf GPL. Both are optional: without them the sync
tool falls back to full-size covers and no cover for PDFs.

## Build-time only

These run during a build and reach neither artifact. They're listed so a license
scan over `node_modules` has an answer:

Turborepo (MIT), Biome (MIT or Apache-2.0), TypeScript (Apache-2.0), Wrangler
(MIT or Apache-2.0), Tailwind CSS (MIT), Lightning CSS (MPL-2.0, unmodified),
`caniuse-lite` (CC-BY-4.0).

## Something wrong here?

Open an issue. A license claim is only useful if it's right.
