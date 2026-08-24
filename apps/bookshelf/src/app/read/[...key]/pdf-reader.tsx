"use client";

import type { BookProgress } from "@bookshelf/core";
import {
  ChevronLeft,
  ChevronRight,
  List,
  Minus,
  Plus,
  Search as SearchIcon,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type Opened,
  type OutlineEntry,
  openPdf,
  readOutline,
  unmarkAll,
} from "@/app/read/[...key]/pdf-document";
import { type PageSize, PdfPage } from "@/app/read/[...key]/pdf-page";
import { usePdfSearch } from "@/app/read/[...key]/pdf-search";
import { type Panel, PdfSidebar } from "@/app/read/[...key]/pdf-sidebar";
import { useReadingPosition } from "@/app/read/[...key]/position";
import { BUTTON_ROUND, SELECT } from "@/app/ui";
import { readStored, writeStored } from "@/lib/local";

type Layout = "spread" | "page" | "scroll";

const LAYOUTS: { value: Layout; label: string }[] = [
  { value: "spread", label: "Two pages" },
  { value: "page", label: "One page" },
  { value: "scroll", label: "Scroll" },
];

type Tint = "paper" | "sepia" | "night";

/**
 * The three ways a page can be lit.
 *
 * A PDF's page is a picture, background and all, so a reader cannot restyle it
 * the way the EPUB reader restyles a chapter — the only honest lever is a filter
 * over the whole thing. That is exact for the text-and-diagrams pages most of
 * this kind of library is made of, and wrong for a photograph, which is why
 * `paper` is the default and the other two are asked for.
 */
type TintOption = {
  value: Tint;
  label: string;
  /** Applied to the canvas, so the page changes and the chrome does not. */
  filter: string;
  /** What a page that has not been drawn yet should look like. */
  paper: string;
};

const TINTS: TintOption[] = [
  { value: "paper", label: "Paper", filter: "none", paper: "#ffffff" },
  {
    value: "sepia",
    label: "Sepia",
    filter: "sepia(0.32) saturate(1.1) brightness(0.97)",
    paper: "#f4ecdc",
  },
  {
    value: "night",
    label: "Night",
    // Inverting alone turns black text white and every colour into its
    // opposite; rotating the hue back through half a turn returns the colours
    // to roughly where they started, so a red heading stays red rather than
    // becoming cyan.
    filter: "invert(1) hue-rotate(180deg)",
    paper: "#111112",
  },
];

/** A CSS pixel is 1/96 inch and a PDF unit is 1/72, so 100% is neither. */
const CSS_UNITS = 96 / 72;

const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

/**
 * How large `auto` will let a page get.
 *
 * Filling the width of a wide monitor with a Letter page sets the body text at
 * around twenty-four points, which is a poster rather than a book. So the
 * default fits the width until doing so would overshoot this, and then stops —
 * which on a phone is the whole width and on a desktop is a column.
 */
const AUTO_MAX = 1.25;

/** How the scale is decided: fitted to something, capped, or simply given. */
type Zoom = "auto" | "width" | "page" | number;

/** Space around the pages, and between them. */
const MARGIN = 24;
const GUTTER = 16;

/** How many pages either side of the reader to keep drawn while scrolling. */
const WINDOW = 2;

/** US Letter, for the moment before the first page has been measured. */
const LETTER: PageSize = { width: 612, height: 792 };

const LAYOUT_KEY = "bookshelf:pdf:layout";
const ZOOM_KEY = "bookshelf:pdf:zoom";
const TINT_KEY = "bookshelf:pdf:tint";

/**
 * Which pages a spread shows.
 *
 * The first page is shown alone, and every pair after it is even-then-odd —
 * which is how a bound book falls open, and puts a chapter's opening on the
 * right where it was set to be.
 */
function spreadOf(page: number, pages: number): number[] {
  if (page <= 1) return [1];
  const left = page % 2 === 0 ? page : page - 1;
  return [left, left + 1].filter((n) => n <= pages);
}

/** Which way a key turns, or nothing for a key that does not turn pages. */
const TURNS: Record<string, 1 | -1 | undefined> = {
  ArrowRight: 1,
  ArrowDown: 1,
  PageDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  PageUp: -1,
};

function clamp(page: number, pages: number): number {
  return Math.min(Math.max(page, 1), Math.max(pages, 1));
}

export function PdfReader({
  url,
  bookId,
  profileId,
  saved,
  canSync,
}: {
  /** `/download/<key>`, which answers ranged requests. */
  url: string;
  bookId: string;
  profileId: string;
  /** This profile's position as the library has it, from any device. */
  saved: BookProgress | null;
  /** False against a library the app cannot write to. */
  canSync: boolean;
}) {
  const scroller = useRef<HTMLElement>(null);

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [sizes, setSizes] = useState<Map<number, PageSize>>(new Map());

  const [page, setPage] = useState(1);
  const [layout, setLayout] = useState<Layout>("scroll");
  const [zoom, setZoom] = useState<Zoom>("auto");
  const [tint, setTint] = useState<Tint>("paper");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

  const { ready, current, record } = useReadingPosition({
    bookId,
    profileId,
    saved,
    canSync,
  });

  const search = usePdfSearch(doc, pages);

  // Read before the document is shown, so a book opens at the size and in the
  // layout it was last read in rather than jumping into it.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const storedLayout = readStored(LAYOUT_KEY);
    if (
      storedLayout === "spread" ||
      storedLayout === "page" ||
      storedLayout === "scroll"
    ) {
      setLayout(storedLayout);
    }

    const storedZoom = readStored(ZOOM_KEY);
    if (
      storedZoom === "auto" ||
      storedZoom === "width" ||
      storedZoom === "page"
    ) {
      setZoom(storedZoom);
    } else if (storedZoom) {
      const parsed = Number(storedZoom);
      if (ZOOM_STEPS.includes(parsed)) setZoom(parsed);
    }

    const storedTint = readStored(TINT_KEY);
    if (
      storedTint === "paper" ||
      storedTint === "sepia" ||
      storedTint === "night"
    ) {
      setTint(storedTint);
    }

    setSettled(true);
  }, []);

  /** The window the pages are laid out in, measured rather than assumed. */
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Opening the document. Everything the chrome needs is asked for here so that
  // `ready` means the whole reader is ready, not just its first page.
  useEffect(() => {
    if (!settled || !ready) return;

    let cancelled = false;
    let opened: Opened | null = null;

    setStatus("loading");

    void (async () => {
      try {
        opened = await openPdf(url);
        if (cancelled) {
          opened.close();
          return;
        }

        const { doc: book } = opened;

        // The first page's shape stands in for every page that has not been
        // measured yet, which is what lets the whole document be laid out
        // before any of it has been read.
        const first = (await book.getPage(1)).getViewport({ scale: 1 });
        if (cancelled) return;

        setSizes(new Map([[1, { width: first.width, height: first.height }]]));
        setPages(book.numPages);
        setDoc(book);
        setPage(clamp(current()?.page ?? 1, book.numPages));
        setStatus("ready");

        // Bookmarks are not needed to read, so a slow outline holds nothing up.
        const entries = await readOutline(book);
        if (!cancelled) setOutline(entries);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      unmarkAll();
      setDoc(null);
      opened?.close();
    };
  }, [url, settled, ready, current]);

  const reference = sizes.get(1) ?? LETTER;

  /**
   * The scale every page is drawn at.
   *
   * One number for the whole document rather than one per page: a scale that
   * changed as you scrolled would resize the pages under the reader. It is
   * computed from the first page for the same reason.
   */
  const scale = useMemo(() => {
    if (typeof zoom === "number") return zoom * CSS_UNITS;
    if (box.width === 0) return CSS_UNITS;

    const across = layout === "spread" ? 2 : 1;
    const room = box.width - MARGIN * 2 - GUTTER * (across - 1);
    const byWidth = room / (reference.width * across);
    if (zoom === "width") return Math.max(byWidth, 0.1);
    if (zoom === "auto") {
      return Math.max(Math.min(byWidth, AUTO_MAX * CSS_UNITS), 0.1);
    }

    const byHeight = (box.height - MARGIN * 2) / reference.height;
    return Math.max(Math.min(byWidth, byHeight), 0.1);
  }, [zoom, box, layout, reference]);

  const onMeasured = useCallback((number: number, size: PageSize) => {
    setSizes((previous) => {
      const known = previous.get(number);
      if (
        known &&
        Math.abs(known.width - size.width) < 0.5 &&
        Math.abs(known.height - size.height) < 0.5
      ) {
        // The same answer as last time: handing back the same map is what keeps
        // a measurement from costing a render.
        return previous;
      }
      const next = new Map(previous);
      next.set(number, size);
      return next;
    });
  }, []);

  /** Which pages are in the document at all, in this layout. */
  const shown = useMemo(() => {
    if (pages === 0) return [];
    if (layout === "scroll") {
      return Array.from({ length: pages }, (_, index) => index + 1);
    }
    if (layout === "spread") return spreadOf(page, pages);
    return [page];
  }, [layout, page, pages]);

  const goTo = useCallback(
    (target: number) => {
      const next = clamp(target, pages);
      setPage(next);

      if (layout !== "scroll") return;
      // In a scroll the page is where the reader is, not what is rendered, so
      // moving means moving the scroll position.
      const element = scroller.current?.querySelector(`[data-page="${next}"]`);
      if (element instanceof HTMLElement && scroller.current) {
        scroller.current.scrollTo({
          top: element.offsetTop - MARGIN,
          behavior: "instant",
        });
      }
    },
    [layout, pages],
  );

  const turn = useCallback(
    (direction: 1 | -1) => {
      if (layout === "spread") {
        const spread = spreadOf(page, pages);
        const target =
          direction === 1
            ? (spread.at(-1) ?? page) + 1
            : (spread[0] ?? page) - 1;
        goTo(clamp(target, pages));
        return;
      }
      goTo(page + direction);
    },
    [layout, page, pages, goTo],
  );

  // The place in the book, once it has settled. The hook debounces the write
  // out to the library; the page is in the browser's copy immediately.
  const started = useRef(false);
  useEffect(() => {
    if (status !== "ready") return;
    // The position a book was opened at is the position it already had.
    if (!started.current) {
      started.current = true;
      return;
    }
    record({ page });
  }, [page, status, record]);

  /**
   * The page, for the effects that need to know it without watching it.
   *
   * Written in an effect rather than during the render — a render can be thrown
   * away, and a ref written in one would not be — and declared above the effect
   * that reads it, so that on a commit which changes both the page and the scale
   * this is the one that runs first.
   */
  const at = useRef(page);
  useEffect(() => {
    at.current = page;
  }, [page]);

  /**
   * Puts the scroll back onto the page the reader was on.
   *
   * Three times over, and for one reason every time: a scroll position is a
   * number of pixels, and every one of these changes what a pixel means. Opening
   * a book, because the page came out of a saved position rather than out of the
   * scrollbar. Returning from one of the page-at-a-time layouts, which had one
   * box where this has all of them. And a change of scale — a zoom, or a window
   * resized under a fit — which leaves the same offset pointing at a different
   * page, thirty pages out at 150% two hundred pages in.
   *
   * Reading the page out of a ref is what keeps this from running on every
   * scroll and fighting the reader for the scrollbar.
   *
   * Every box exists by now — a page that has not been measured is still a box,
   * at the first page's proportions — so an offset is available immediately, and
   * is approximate for a document whose pages are not all one size.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: `scale` is a trigger rather than an input — a change of scale is what makes the offset the reader is sitting at point at a different page.
  useEffect(() => {
    if (status !== "ready" || layout !== "scroll") return;

    const element = scroller.current?.querySelector(
      `[data-page="${at.current}"]`,
    );
    if (element instanceof HTMLElement && scroller.current) {
      scroller.current.scrollTop = element.offsetTop - MARGIN;
    }
  }, [status, layout, scale]);

  /**
   * Gives the book the keyboard as soon as there is a book.
   *
   * The keys are on the scrolling region rather than on the window, which is
   * what lets paging and the browser's own scrolling share one target — but it
   * also means they do nothing until something has focused it. Opening a book
   * and pressing the right arrow should turn the page, not wait for a click.
   *
   * `preventScroll` because focusing an element normally scrolls it into view,
   * and this one has just been put where the reader left off.
   */
  useEffect(() => {
    if (status !== "ready") return;
    scroller.current?.focus({ preventScroll: true });
  }, [status]);

  /**
   * Which page the reader is looking at, while scrolling.
   *
   * The most-visible page rather than the topmost, so that a page turned to at
   * the bottom of the window does not count as the current one until it is
   * actually being read. Ties go to the lower number, which is the one in front.
   */
  const seen = useRef(new Map<number, number>());
  useEffect(() => {
    const element = scroller.current;
    if (layout !== "scroll" || !element || status !== "ready") return;

    seen.current.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const number = Number(
            (entry.target as HTMLElement).dataset.page ?? "0",
          );
          if (number) seen.current.set(number, entry.intersectionRatio);
        }

        // Ascending, and strictly better to win, so a tie goes to the lower
        // page — the one in front.
        let best = 0;
        let ratio = 0;
        for (const number of [...seen.current.keys()].sort((a, b) => a - b)) {
          const value = seen.current.get(number) ?? 0;
          if (value > ratio) {
            best = number;
            ratio = value;
          }
        }
        if (best) setPage(best);
      },
      { root: element, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
    );

    for (const node of element.querySelectorAll("[data-page]")) {
      observer.observe(node);
    }
    // The boxes are created in the same commit that makes the document ready,
    // so `status` is what says there is something to observe.
    return () => observer.disconnect();
  }, [layout, status]);

  /**
   * Keys, on the scroll container rather than on the window.
   *
   * Which means the browser's own scrolling still works when the region has
   * focus, and that is why only the page-at-a-time layouts take the keys that
   * would otherwise scroll: in a continuous scroll, an arrow or a page-down
   * should do what it does everywhere else. The ends of the book are the
   * exception — nothing else is going to answer for those.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Home" || event.key === "End") {
        goTo(event.key === "Home" ? 1 : pages);
        event.preventDefault();
        return;
      }

      if (layout === "scroll") return;

      const direction =
        event.key === " " ? (event.shiftKey ? -1 : 1) : TURNS[event.key];
      if (!direction) return;

      turn(direction);
      event.preventDefault();
    },
    [layout, turn, goTo, pages],
  );

  /** A swipe, which on a touchscreen is what turning a page is. */
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = useCallback((event: React.TouchEvent) => {
    const point = event.touches[0];
    touch.current = point ? { x: point.clientX, y: point.clientY } : null;
  }, []);
  const onTouchEnd = useCallback(
    (event: React.TouchEvent) => {
      const from = touch.current;
      touch.current = null;
      if (!from || layout === "scroll") return;

      const point = event.changedTouches[0];
      if (!point) return;

      const moved = point.clientX - from.x;
      // Sideways, and decisively: a diagonal drag is someone panning a page
      // they have zoomed into, and a short one is a tap.
      if (
        Math.abs(moved) < 60 ||
        Math.abs(moved) < Math.abs(point.clientY - from.y)
      ) {
        return;
      }
      turn(moved < 0 ? 1 : -1);
    },
    [layout, turn],
  );

  const changeLayout = useCallback((next: Layout) => {
    writeStored(LAYOUT_KEY, next);
    setLayout(next);
  }, []);

  const changeZoom = useCallback((next: Zoom) => {
    writeStored(ZOOM_KEY, String(next));
    setZoom(next);
  }, []);

  const changeTint = useCallback((next: Tint) => {
    writeStored(TINT_KEY, next);
    setTint(next);
  }, []);

  const step = useCallback(
    (direction: 1 | -1) => {
      const from = typeof zoom === "number" ? zoom : scale / CSS_UNITS;
      const next =
        direction === 1
          ? ZOOM_STEPS.find((value) => value > from + 0.001)
          : [...ZOOM_STEPS].reverse().find((value) => value < from - 0.001);
      if (next !== undefined) changeZoom(next);
    },
    [zoom, scale, changeZoom],
  );

  const look = TINTS.find((option) => option.value === tint) ?? TINTS[0];

  // A spread reaches the last page one turn before a single page does, so the
  // button has to ask the layout rather than compare two numbers.
  const atEnd =
    pages === 0 ||
    (layout === "spread" ? (spreadOf(page, pages).at(-1) ?? page) : page) >=
      pages;

  return (
    <div className="flex min-h-0 flex-1">
      {panel && doc && (
        <PdfSidebar
          panel={panel}
          outline={outline}
          page={page}
          search={search}
          onGo={(target) => goTo(target)}
          onClose={() => setPanel(null)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* A labelled, scrollable region that also takes the keyboard: paging
            and the browser's own scrolling then have one target rather than
            two. A `section` with a label is a region without having to say so.
            */}
        <section
          ref={scroller}
          aria-label="The book"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container that cannot be focused cannot be scrolled without a pointer.
          tabIndex={0}
          onKeyDown={onKeyDown}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          style={
            {
              "--page-filter": look.filter,
              "--page-paper": look.paper,
            } as React.CSSProperties
          }
          className={`relative min-h-0 flex-1 overflow-auto outline-none ${
            tint === "night" ? "bg-[#0b0b0c]" : "bg-fill"
          }`}
        >
          {doc && status === "ready" ? (
            <div
              className="flex min-h-full w-full items-start justify-center"
              style={{ padding: MARGIN }}
            >
              <div
                className={`flex ${
                  layout === "scroll" ? "flex-col" : "flex-row"
                }`}
                style={{ gap: GUTTER }}
              >
                {shown.map((number) => (
                  <PdfPage
                    key={number}
                    doc={doc}
                    number={number}
                    scale={scale}
                    size={sizes.get(number) ?? reference}
                    draw={
                      layout !== "scroll" || Math.abs(number - page) <= WINDOW
                    }
                    query={search.needle}
                    onMeasured={onMeasured}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              {status === "error" ? (
                <p className="text-sm text-secondary">
                  This book could not be opened.
                </p>
              ) : (
                <div className="aspect-[17/22] w-full max-w-md animate-pulse rounded bg-surface/60" />
              )}
            </div>
          )}
        </section>

        {/* How far through the book, as a line rather than a number — the
            numbers are in the toolbar, and this is the part read at a glance. */}
        <div className="h-px w-full bg-separator">
          <div
            className="h-px bg-accent transition-[width] duration-200"
            style={{ width: pages ? `${(page / pages) * 100}%` : 0 }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-separator px-4 py-2.5">
          <div className="flex items-center gap-1">
            <Toggle
              on={panel === "contents"}
              onClick={() => setPanel(panel === "contents" ? null : "contents")}
              label="Contents"
            >
              <List aria-hidden="true" className="size-4" />
            </Toggle>
            <Toggle
              on={panel === "search"}
              onClick={() => setPanel(panel === "search" ? null : "search")}
              label="Search in this book"
            >
              <SearchIcon aria-hidden="true" className="size-4" />
            </Toggle>
          </div>

          <div className="flex items-center gap-1">
            <Round
              onClick={() => turn(-1)}
              label="Previous page"
              disabled={page <= 1}
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Round>
            <PageBox page={page} pages={pages} onGo={goTo} />
            <Round onClick={() => turn(1)} label="Next page" disabled={atEnd}>
              <ChevronRight aria-hidden="true" className="size-4" />
            </Round>
          </div>

          <div className="ml-auto flex items-center gap-1">
            <Round onClick={() => step(-1)} label="Zoom out">
              <Minus aria-hidden="true" className="size-4" />
            </Round>
            <select
              aria-label="Zoom"
              value={typeof zoom === "number" ? String(zoom) : zoom}
              onChange={(event) => {
                const chosen = event.target.value;
                changeZoom(
                  chosen === "auto" || chosen === "width" || chosen === "page"
                    ? chosen
                    : Number(chosen),
                );
              }}
              className={`${SELECT} shrink-0`}
            >
              <option value="auto">Automatic</option>
              <option value="width">Fit width</option>
              <option value="page">Fit page</option>
              {ZOOM_STEPS.map((value) => (
                <option key={value} value={value}>
                  {Math.round(value * 100)}%
                </option>
              ))}
            </select>
            <Round onClick={() => step(1)} label="Zoom in">
              <Plus aria-hidden="true" className="size-4" />
            </Round>
          </div>

          <select
            aria-label="Reading layout"
            value={layout}
            onChange={(event) => changeLayout(event.target.value as Layout)}
            className={`${SELECT} shrink-0`}
          >
            {LAYOUTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Page tint"
            value={tint}
            onChange={(event) => changeTint(event.target.value as Tint)}
            className={`${SELECT} shrink-0`}
          >
            {TINTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

function Round({
  onClick,
  label,
  disabled,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={BUTTON_ROUND}
    >
      {children}
    </button>
  );
}

function Toggle({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      className={`rounded-full p-2 transition-colors ${
        on
          ? "bg-accent text-white hover:bg-accent-hover"
          : "bg-fill hover:bg-fill-hover"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The page number, as somewhere to go rather than only something to read.
 *
 * Kept as its own text while being typed in — a field that snapped to the
 * document on every keystroke could not be typed in at all — and committed on
 * Enter or on leaving.
 */
function PageBox({
  page,
  pages,
  onGo,
}: {
  page: number;
  pages: number;
  onGo: (page: number) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);

  const commit = () => {
    if (typed === null) return;
    const wanted = Number.parseInt(typed, 10);
    setTyped(null);
    if (Number.isFinite(wanted)) onGo(wanted);
  };

  return (
    <span className="flex items-center gap-1 text-sm tabular-nums text-secondary">
      <input
        type="text"
        inputMode="numeric"
        aria-label="Page"
        value={typed ?? String(page)}
        onChange={(event) => setTyped(event.target.value.replace(/\D/g, ""))}
        onFocus={(event) => event.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") setTyped(null);
        }}
        className="w-12 rounded-lg bg-fill px-2 py-1.5 text-center text-sm tabular-nums outline-none transition-shadow focus:ring-2 focus:ring-accent"
      />
      <span className="shrink-0 text-tertiary">of {pages || "…"}</span>
    </span>
  );
}
