"use client";

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

/**
 * Opening a PDF, and the two things the chrome needs out of one: its outline,
 * and its text.
 *
 * Kept apart from the reader because none of it is React — it is pdf.js's
 * asynchronous, page-at-a-time API translated into the shapes the reader
 * actually renders.
 */

/**
 * Where pdf.js's own files are served from.
 *
 * It asks for these by URL at the moment it needs them, so they are copied out
 * of the package rather than bundled — see `scripts/pdfjs-assets.ts`. Every one
 * of them is conditional: a document with no CJK text never fetches a CMap, and
 * a document with no JPEG 2000 images never fetches the WebAssembly to decode
 * them.
 */
const ASSETS = "/pdfjs/";

/**
 * How much of the file to ask for at a time.
 *
 * 128 KB is a compromise between round trips and waste. `/download` answers
 * ranged requests, which is what makes the choice matter at all: a 40 MB book
 * opens on a few of these rather than on all of it.
 */
const RANGE_CHUNK = 1 << 17;

type Pdfjs = typeof import("pdfjs-dist");

let loading: Promise<Pdfjs> | null = null;

/**
 * pdf.js, loaded once and configured on the way in.
 *
 * Imported here rather than at module scope because it reaches for `window` and
 * for a `Worker` as it initialises, neither of which exists during the server
 * render.
 */
function pdfjs(): Promise<Pdfjs> {
  loading ??= import("pdfjs-dist").then((module) => {
    module.GlobalWorkerOptions.workerSrc = `${ASSETS}pdf.worker.min.mjs`;
    return module;
  });
  return loading;
}

/** An open document, and the way to let go of it. */
export type Opened = {
  doc: PDFDocumentProxy;
  /** Aborts anything still in flight and shuts the worker down. */
  close: () => void;
};

export async function openPdf(url: string): Promise<Opened> {
  const { getDocument } = await pdfjs();

  const task = getDocument({
    url,
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
    rangeChunkSize: RANGE_CHUNK,
    // Fetch the pages being looked at and nothing else. Left on, pdf.js pulls
    // the rest of the file down in the background as soon as it has the first
    // pages, which for a scanned book is tens of megabytes nobody asked for.
    // Streaming is turned off with it, since a stream of the whole file is the
    // same download by another route.
    disableAutoFetch: true,
    disableStream: true,
    // Forms are not part of reading, and an XFA document is an application
    // rather than a book.
    enableXfa: false,
  });

  // The loading task owns the worker and the requests, not the document — so it
  // is what has to be kept in order to stop them, and what has to be let go of
  // when there is never going to be a document. A book that fails to open would
  // otherwise leave a worker running for as long as the tab is.
  try {
    return { doc: await task.promise, close: () => void task.destroy() };
  } catch (error) {
    await task.destroy().catch(() => {});
    throw error;
  }
}

/** One line of a table of contents, flattened but still knowing its depth. */
export type OutlineEntry = {
  /**
   * Where this bookmark sits in the document's own order.
   *
   * Its identity, and not the same thing as its position in this list: entries
   * with no title are dropped, and two bookmarks in a long book are often the
   * same words pointing at different pages.
   */
  id: number;
  title: string;
  depth: number;
  /** Null where a bookmark points at something that is not a page here. */
  page: number | null;
};

type RawOutline = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>;

/**
 * Which page a bookmark leads to.
 *
 * A destination is either named, and has to be looked up, or explicit, in which
 * case its first element identifies the page — as a reference that needs
 * resolving, or already as an index. A bookmark that points at a URL, or at a
 * page this document does not have, resolves to nothing and is shown without a
 * page rather than hidden.
 */
async function destinationPage(
  doc: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  if (!dest) return null;

  try {
    const explicit =
      typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;

    const target = explicit[0];
    if (typeof target === "number") return target + 1;
    if (typeof target !== "object" || target === null) return null;

    return (await doc.getPageIndex(target as never)) + 1;
  } catch {
    return null;
  }
}

/**
 * The document's outline as a flat list, every entry already knowing its page.
 *
 * Resolved up front rather than on click so that the contents can say where
 * each entry goes and the reader can show which section it is currently in.
 * Each lookup is a message to the worker against a page tree it has already
 * parsed, and they all go at once, so the cost is one round of work after the
 * document opens — by which time the first page is drawn.
 */
export async function readOutline(
  doc: PDFDocumentProxy,
): Promise<OutlineEntry[]> {
  let outline: RawOutline | null;
  try {
    outline = await doc.getOutline();
  } catch {
    // A malformed outline is not a reason to fail to open a book.
    return [];
  }
  if (!outline?.length) return [];

  const flat: {
    title: string;
    depth: number;
    dest: string | unknown[] | null;
  }[] = [];

  const walk = (items: RawOutline, depth: number) => {
    for (const item of items) {
      flat.push({ title: item.title, depth, dest: item.dest });
      if (item.items?.length) walk(item.items as RawOutline, depth + 1);
    }
  };
  walk(outline, 0);

  const pages = await Promise.all(
    flat.map((entry) => destinationPage(doc, entry.dest)),
  );

  return (
    flat
      .map(({ title, depth }, index) => ({
        id: index,
        title: title.trim(),
        depth,
        page: pages[index] ?? null,
      }))
      // A bookmark with no title is a line the reader cannot click on usefully.
      .filter((entry) => entry.title.length > 0)
  );
}

/**
 * One page's text, as one string.
 *
 * pdf.js hands back positioned runs rather than prose, so the joining is a
 * guess: `hasEOL` marks a run that ended a line, and everything else is
 * separated by a space. That is wrong for a hyphenated word broken across a
 * line and right for the rest, which is the trade a search box wants.
 */
export async function pageText(
  doc: PDFDocumentProxy,
  page: number,
): Promise<string> {
  try {
    const content = await (await doc.getPage(page)).getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
      else if (item.str && !item.str.endsWith(" ")) text += " ";
    }
    return text;
  } catch {
    return "";
  }
}

/**
 * Text reduced to what a search should match on, and a way back to where it
 * came from.
 *
 * Three things happen at once: case is folded, accents are dropped — the same
 * `NFKD` decomposition the sync tool uses to turn a title into a directory
 * name, so `Bronte` finds `Brontë` — and every run of whitespace becomes one
 * space, which is what lets a two-word query match across a line break.
 *
 * All three change the length of the string, and an excerpt has to be cut out
 * of the *original* text or it would be shown to the reader stripped and
 * lower-cased. So `map` records, for each character of the folded text, the
 * index it came from. Decomposing one character at a time rather than the whole
 * string is what keeps that correspondence available.
 */
export type Folded = { folded: string; map: number[] };

const DIACRITICS = /\p{Diacritic}/gu;

export function fold(text: string): Folded {
  let folded = "";
  const map: number[] = [];
  let space = false;

  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);

    // A run of whitespace, however long, is one space attributed to its start.
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      if (!space && folded.length > 0) {
        folded += " ";
        map.push(at);
        space = true;
      }
      continue;
    }
    space = false;

    // Almost all of a book is ASCII, and taking it apart with a regex is the
    // slow path — over a few hundred pages the difference is seconds.
    if (code < 0x80) {
      folded +=
        code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : text[at];
      map.push(at);
      continue;
    }

    const piece = text[at]
      .normalize("NFKD")
      .replace(DIACRITICS, "")
      .toLowerCase();
    // A lone combining mark folds away to nothing, and contributes nothing.
    for (const character of piece) {
      folded += character;
      map.push(at);
    }
  }

  return { folded, map };
}

/** How much of the sentence around a hit to show with it. */
const EXCERPT_BEFORE = 56;
const EXCERPT_AFTER = 104;

/**
 * The run-up to a match, cut back to where a word starts.
 *
 * Slicing a fixed number of characters lands mid-word about five times out of
 * six, and a result list of `lace. Between the shelf` reads as a bug in the
 * search rather than as a window onto a page. The ellipsis says the sentence
 * began before this.
 */
function lead(text: string, from: number, to: number): string {
  const piece = text.slice(from, to).replace(/\s+/g, " ");
  if (from === 0) return piece.trimStart();

  const space = piece.indexOf(" ");
  return space === -1 ? "" : `…${piece.slice(space + 1)}`;
}

/** The same, forwards: cut back to where the last whole word ends. */
function trail(text: string, from: number, want: number): string {
  const to = Math.min(text.length, from + want);
  const piece = text.slice(from, to).replace(/\s+/g, " ");
  if (to === text.length) return piece.trimEnd();

  const space = piece.lastIndexOf(" ");
  return space === -1 ? piece.trimEnd() : `${piece.slice(0, space)}…`;
}

export type Hit = {
  page: number;
  /**
   * Where the match starts in the page's text.
   *
   * Its identity within the page — a common word is found a dozen times on one
   * — and the number a reader would need in order to scroll to the hit itself
   * rather than to the top of the page it is on.
   */
  at: number;
  /** The surrounding text, as written, with the match marked inside it. */
  before: string;
  match: string;
  after: string;
};

/**
 * Every occurrence of a folded query on one page.
 *
 * Overlapping matches are not something a reader wants to scroll through, so
 * the search resumes after each hit rather than one character on.
 */
export function findOnPage(
  page: number,
  text: string,
  { folded, map }: Folded,
  query: string,
): Hit[] {
  if (!query) return [];

  const hits: Hit[] = [];
  let at = folded.indexOf(query);

  while (at !== -1) {
    const start = map[at] ?? 0;
    // The character after the last one the match covers, back in the original.
    const last = map[at + query.length - 1] ?? start;
    const end = Math.min(text.length, last + 1);

    hits.push({
      page,
      at: start,
      before: lead(text, Math.max(0, start - EXCERPT_BEFORE), start),
      // A match that fell across a line break carries the break with it.
      match: text.slice(start, end).replace(/\s+/g, " "),
      after: trail(text, end, EXCERPT_AFTER),
    });

    at = folded.indexOf(query, at + query.length);
  }

  return hits;
}

/** A rendered text layer, and the way to take it back down. */
export type Layer = { cancel: () => void };

/**
 * Draws the invisible, selectable text over a rendered page.
 *
 * This is what makes a page more than a picture of one: text can be selected
 * and copied, a screen reader has something to read, and the browser's own find
 * works. pdf.js positions each run absolutely and sizes it from
 * `--total-scale-factor`, which is why the scale is set on the container rather
 * than baked into the spans — see the `.textLayer` rules in `globals.css`.
 */
export async function renderTextLayer({
  page,
  scale,
  container,
}: {
  /** The page as the caller already has it, rather than its number. */
  page: PDFPageProxy;
  scale: number;
  container: HTMLDivElement;
}): Promise<Layer> {
  const { TextLayer, setLayerDimensions } = await pdfjs();

  const viewport = page.getViewport({ scale });

  container.replaceChildren();
  container.style.setProperty("--total-scale-factor", String(scale));
  setLayerDimensions(container, viewport);

  const layer = new TextLayer({
    textContentSource: page.streamTextContent(),
    container,
    viewport,
  });

  await layer.render();
  return { cancel: () => layer.cancel() };
}

/**
 * Marks every occurrence of a query inside a rendered text layer.
 *
 * The spans a text layer is made of are positioned runs, not words, so a match
 * can begin in one and end three later. Walking the layer's text nodes into one
 * string with an index back to each node is what makes a `Range` across them
 * possible.
 *
 * Drawn with the browser's own highlight registry rather than by wrapping the
 * text in elements, because the runs are absolutely positioned and splitting one
 * moves the words inside it. Where that registry is missing the search still
 * works and still jumps to the right page; only the marking is absent.
 */
export function highlightInLayer(
  container: HTMLElement,
  query: string,
): Range[] {
  if (!query) return [];

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: { node: Text; at: number }[] = [];
  let text = "";

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, at: text.length });
    text += node.nodeValue ?? "";
  }

  const { folded, map } = fold(text);
  const ranges: Range[] = [];

  /** Which text node a whole-layer offset falls in, and where inside it. */
  const locate = (offset: number): { node: Text; offset: number } | null => {
    let low = 0;
    let high = nodes.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const entry = nodes[middle];
      const length = entry.node.nodeValue?.length ?? 0;
      if (offset < entry.at) high = middle - 1;
      else if (offset >= entry.at + length) low = middle + 1;
      else return { node: entry.node, offset: offset - entry.at };
    }
    return null;
  };

  for (let at = folded.indexOf(query); at !== -1; ) {
    const start = locate(map[at] ?? 0);
    const end = locate(map[at + query.length - 1] ?? 0);

    if (start && end) {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset + 1);
      ranges.push(range);
    }

    at = folded.indexOf(query, at + query.length);
  }

  return ranges;
}

/** The name the reader's search highlight is registered under. */
export const FIND_HIGHLIGHT = "bookshelf-find";

/**
 * The ranges each page is currently contributing to the search highlight.
 *
 * Module state, because what it mirrors is module state: `CSS.highlights` is one
 * registry for the document, so the pages have to pool their ranges into a
 * single entry rather than each keeping their own. Only one reader is ever on
 * screen, which is what makes that safe.
 */
const marked = new Map<number, Range[]>();

/**
 * Teaches the page what a search highlight looks like.
 *
 * The rule is inserted from here rather than written in `globals.css` because
 * `::highlight()` is newer than the stylesheet pipeline that would compile it:
 * the CSS optimiser does not recognise the pseudo-element and drops the rule on
 * the floor. `insertRule` throws on a selector the browser cannot parse, which
 * is the feature test — a browser without the Custom Highlight API ends up with
 * no rule and no registry, which is consistent rather than half-applied.
 */
let styled = false;

function styleHighlight(): void {
  if (styled) return;
  styled = true;

  try {
    const sheet = new CSSStyleSheet();
    sheet.insertRule(
      `::highlight(${FIND_HIGHLIGHT}) { background: color-mix(in srgb, #ffd60a 55%, transparent); color: transparent; }`,
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Nothing to mark with. The search still finds and still jumps.
  }
}

/** Rebuilds the registry entry from every page that has something in it. */
function publishHighlights(): void {
  // Absent in browsers without the Custom Highlight API. Search still finds and
  // still jumps; the marking is what is missing.
  const registry = CSS.highlights;
  if (!registry) return;

  const all = [...marked.values()].flat();
  if (all.length === 0) {
    registry.delete(FIND_HIGHLIGHT);
    return;
  }

  styleHighlight();
  registry.set(FIND_HIGHLIGHT, new Highlight(...all));
}

export function markPage(page: number, ranges: Range[]): void {
  if (ranges.length === 0) marked.delete(page);
  else marked.set(page, ranges);
  publishHighlights();
}

export function unmarkAll(): void {
  marked.clear();
  publishHighlights();
}
