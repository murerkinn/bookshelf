"use client";

import type { BookProgress } from "@bookshelf/core";
import type { Book, NavItem, Rendition } from "epubjs";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useReadingPosition } from "@/app/read/[...key]/position";
import { BUTTON_ROUND, SELECT } from "@/app/ui";
import { readStored, writeStored } from "@/lib/local";

type Mode = "single" | "double" | "scroll";

const MODES: { value: Mode; label: string }[] = [
  { value: "double", label: "Two pages" },
  { value: "single", label: "One page" },
  { value: "scroll", label: "Scroll" },
];

const MODE_STORAGE_KEY = "bookshelf:mode";

/** How many spine items ahead to pull into the browser cache. */
const PREFETCH_AHEAD = 2;

/** What the reader stored before positions were shared between devices. */
function legacyProgressKey(bookKey: string): string {
  return `bookshelf:progress:${bookKey}`;
}

/** Table of contents entries nest; one flat list with indentation is enough. */
function flatten(
  items: NavItem[],
  depth = 0,
): { item: NavItem; depth: number }[] {
  return items.flatMap((item) => [
    { item, depth },
    ...flatten(item.subitems ?? [], depth + 1),
  ]);
}

type SpineItem = { href: string; index: number; linear?: string };

function spineItems(book: Book): SpineItem[] {
  return (
    (book.spine as unknown as { spineItems?: SpineItem[] }).spineItems ?? []
  );
}

/**
 * Where to open a book that has never been read.
 *
 * The first spine item is usually a full-bleed cover image — around a megabyte
 * in this library — and the shelf has already shown that cover. Starting at the
 * first real section avoids downloading it again just to look at it.
 */
function firstReadableHref(book: Book): string | undefined {
  return spineItems(book).find(
    (item) => item.linear !== "no" && !/cover/i.test(item.href),
  )?.href;
}

export function EpubReader({
  opfUrl,
  bookKey,
  bookId,
  profileId,
  saved,
  canSync,
}: {
  opfUrl: string;
  bookKey: string;
  bookId: string;
  profileId: string;
  /** This profile's position as the library has it, from any device. */
  saved: BookProgress | null;
  /** False against a library the app cannot write to. */
  canSync: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const rendition = useRef<Rendition | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [label, setLabel] = useState("");
  const [toc, setToc] = useState<{ item: NavItem; depth: number }[]>([]);
  const [mode, setMode] = useState<Mode>("double");

  const legacy = useCallback(() => {
    const raw = readStored(legacyProgressKey(bookKey));
    if (!raw) return null;
    return {
      cfi: raw,
      // Dated to the epoch so the library's copy wins the moment there is one,
      // rather than a device's history outranking it forever.
      updatedAt: new Date(0).toISOString(),
    };
  }, [bookKey]);

  const { ready, current, record } = useReadingPosition({
    bookId,
    profileId,
    saved,
    canSync,
    legacy,
  });

  // Read before the book is rendered, so it is only ever built once, for the
  // layout the reader actually wants.
  const [modeRestored, setModeRestored] = useState(false);
  useEffect(() => {
    const savedMode = readStored(MODE_STORAGE_KEY);
    if (
      savedMode === "single" ||
      savedMode === "double" ||
      savedMode === "scroll"
    ) {
      setMode(savedMode);
    }
    setModeRestored(true);
  }, []);

  const restored = modeRestored && ready;

  useEffect(() => {
    const element = container.current;
    if (!element || !restored) return;

    let book: Book | null = null;
    let cancelled = false;

    function onKeyDown(event: { key?: string }) {
      if (event.key === "ArrowLeft") rendition.current?.prev();
      if (event.key === "ArrowRight") rendition.current?.next();
    }

    function onResize() {
      (
        rendition.current as unknown as { resize?: () => void } | null
      )?.resize?.();
    }

    /**
     * Warms the browser cache with the sections just ahead, so turning the page
     * doesn't wait on a round trip out to R2 and back.
     */
    function prefetchAhead(opened: Book, index?: number) {
      if (typeof index !== "number") return;
      const items = spineItems(opened);
      for (let i = index + 1; i <= index + PREFETCH_AHEAD; i++) {
        const next = items[i];
        if (!next) break;
        // A prefetch that fails costs nothing; the real load will retry.
        void fetch(opened.resolve(next.href)).catch(() => {});
      }
    }

    setStatus("loading");

    // epub.js touches window at import time, so it is loaded here rather than
    // at module scope, where it would break the server render.
    import("epubjs")
      .then(({ default: ePub }) => {
        if (cancelled) return;

        // Pointed at the .opf so epub.js fetches chapters one at a time instead
        // of pulling down the entire archive.
        const opened = ePub(opfUrl);
        book = opened;

        const view = opened.renderTo(element, {
          width: "100%",
          height: "100%",
          flow: mode === "scroll" ? "scrolled" : "paginated",
          // The continuous manager appends the next section as you reach the
          // end of one, so scrolling runs through the book rather than
          // stopping dead at each chapter boundary.
          manager: mode === "scroll" ? "continuous" : "default",
          spread: mode === "double" ? "auto" : "none",
          // Book markup is untrusted: no scripts inside the iframe.
          allowScriptedContent: false,
        });
        rendition.current = view;

        // Fires for every move — buttons, keyboard and contents jumps alike —
        // so position and label stay in step however the reader got there.
        view.on(
          "relocated",
          (location: {
            start?: { cfi?: string; href?: string; index?: number };
          }) => {
            setLabel(location.start?.href ?? "");

            if (location.start?.cfi) {
              record({ cfi: location.start.cfi, href: location.start.href });
            }

            prefetchAhead(opened, location.start?.index);
          },
        );

        // Arrow keys while the book itself has focus: epub.js re-emits DOM
        // events from inside its iframe, which a window listener never sees.
        view.on("keydown", onKeyDown);

        opened.loaded.navigation
          .then((navigation) => {
            if (!cancelled) setToc(flatten(navigation.toc));
          })
          .catch(() => {
            // A book with no usable nav document still reads front to back.
          });

        // `ready` resolves once the spine is parsed, which is what tells us
        // where the cover ends and the book begins.
        return opened.ready.then(() =>
          view.display(current()?.cfi ?? firstReadableHref(opened)),
        );
      })
      .then(() => {
        if (!cancelled) setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      rendition.current = null;
      book?.destroy();
    };
    // `mode` rebuilds the rendition: epub.js reflows far more reliably from a
    // fresh render than from a flow change applied to a live one, and the saved
    // position puts the reader straight back where it was.
  }, [opfUrl, mode, restored, current, record]);

  const turn = useCallback((direction: "prev" | "next") => {
    const view = rendition.current;
    if (direction === "prev") view?.prev();
    else view?.next();
  }, []);

  const changeMode = useCallback((next: Mode) => {
    writeStored(MODE_STORAGE_KEY, next);
    setMode(next);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex-1">
        {/* Full width when paginated; a readable column when scrolling, since
            book CSS assumes a page rather than a 1440px browser window. */}
        <div
          ref={container}
          className={`absolute inset-0 ${mode === "scroll" ? "mx-auto max-w-3xl" : ""}`}
        />
        {status !== "ready" && (
          <div className="absolute inset-0 flex items-center justify-center">
            {status === "error" ? (
              <p className="text-sm text-secondary">
                This book could not be opened.
              </p>
            ) : (
              <div className="w-full max-w-md animate-pulse space-y-3 px-6">
                <div className="h-3 w-2/3 rounded bg-fill" />
                <div className="h-3 rounded bg-fill" />
                <div className="h-3 rounded bg-fill" />
                <div className="h-3 w-5/6 rounded bg-fill" />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-separator px-6 py-3">
        <button
          type="button"
          onClick={() => turn("prev")}
          aria-label="Previous page"
          className={BUTTON_ROUND}
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
        </button>

        {toc.length > 0 ? (
          <select
            aria-label="Jump to chapter"
            value=""
            onChange={(event) => {
              if (event.target.value) {
                rendition.current?.display(event.target.value);
              }
            }}
            className={`${SELECT} min-w-0 flex-1 truncate`}
          >
            <option value="">{label || "Contents"}</option>
            {toc.map(({ item, depth }) => (
              <option key={item.href} value={item.href}>
                {`${"  ".repeat(depth)}${item.label.trim()}`}
              </option>
            ))}
          </select>
        ) : (
          <span className="flex-1 truncate text-sm text-secondary">
            {label}
          </span>
        )}

        <select
          aria-label="Reading layout"
          value={mode}
          onChange={(event) => changeMode(event.target.value as Mode)}
          className={`${SELECT} shrink-0`}
        >
          {MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => turn("next")}
          aria-label="Next page"
          className={BUTTON_ROUND}
        >
          <ChevronRight aria-hidden="true" className="size-4" />
        </button>
      </div>
    </div>
  );
}
