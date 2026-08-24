"use client";

import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Folded,
  findOnPage,
  fold,
  type Hit,
  pageText,
} from "@/app/read/[...key]/pdf-document";

/**
 * Searching inside the book.
 *
 * Nothing on the server takes part: the text is already coming to the browser
 * to be drawn, so the same worker that renders a page can be asked what it says.
 * The cost is one pass over the document the first time, and nothing after that
 * — a second query over a book already read is answered out of memory.
 *
 * Results arrive as they are found rather than at the end, because a query
 * against a five-hundred-page book takes a few seconds and the first hit is
 * usually the one wanted.
 */

/** Long enough that a pause reads as a pause, short enough to feel immediate. */
const DEBOUNCE_MS = 250;

/**
 * A single letter matches most of a book, so waiting for two is not a
 * restriction — it is the difference between a search and a scan.
 */
const MIN_QUERY = 2;

/**
 * Where the list stops being a list.
 *
 * A common word in a long book has thousands of hits and nobody scrolls them.
 * The count says it was cut off, so the answer is to type more rather than to
 * wonder.
 */
const MAX_HITS = 500;

/** How many pages to get through before letting the browser draw. */
const YIELD_EVERY = 8;

export type Search = {
  query: string;
  setQuery: (query: string) => void;
  /** The query as the pages are matched against it: folded, or empty. */
  needle: string;
  hits: Hit[];
  /** How far through the document the scan has got, as a page number. */
  scanned: number;
  running: boolean;
  /** True when the scan stopped because there were too many hits to list. */
  truncated: boolean;
};

export function usePdfSearch(
  doc: PDFDocumentProxy | null,
  pages: number,
): Search {
  const [query, setQuery] = useState("");
  const [needle, setNeedle] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [scanned, setScanned] = useState(0);
  const [running, setRunning] = useState(false);
  const [truncated, setTruncated] = useState(false);

  /**
   * Every page's text, and its folded copy, once it has been read.
   *
   * Held for as long as the book is open. A page of prose is a couple of
   * kilobytes, so a long book is a few megabytes — which buys the second query
   * over it for nothing.
   */
  const cache = useRef(new Map<number, { text: string; folded: Folded }>());

  /**
   * A new document is a new book; nothing about the last one still applies.
   *
   * Done while rendering rather than in an effect, which is what React asks for
   * when state has to be dropped because a prop changed: an effect would let one
   * render through first, and that render would show the last book's results
   * against the new book's pages.
   */
  const [opened, setOpened] = useState(doc);
  if (doc !== opened) {
    setOpened(doc);
    cache.current = new Map();
    setQuery("");
    setNeedle("");
    setHits([]);
    setScanned(0);
    setRunning(false);
    setTruncated(false);
  }

  useEffect(() => {
    const wanted = fold(query.trim()).folded;

    if (!doc || wanted.length < MIN_QUERY) {
      setNeedle("");
      setHits([]);
      setScanned(0);
      setRunning(false);
      setTruncated(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      setNeedle(wanted);
      setHits([]);
      setScanned(0);
      setTruncated(false);
      setRunning(true);

      void (async () => {
        const found: Hit[] = [];

        for (let page = 1; page <= pages; page++) {
          if (cancelled) return;

          let entry = cache.current.get(page);
          if (!entry) {
            const text = await pageText(doc, page);
            if (cancelled) return;
            entry = { text, folded: fold(text) };
            cache.current.set(page, entry);
          }

          found.push(...findOnPage(page, entry.text, entry.folded, wanted));

          if (found.length >= MAX_HITS) {
            setHits(found.slice(0, MAX_HITS));
            setScanned(page);
            setTruncated(true);
            setRunning(false);
            return;
          }

          // Handing the results over in batches rather than per page: a page
          // with no hits on it should not cost a render.
          if (page % YIELD_EVERY === 0 || page === pages) {
            setHits([...found]);
            setScanned(page);
          }
        }

        if (!cancelled) setRunning(false);
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, pages, query]);

  const change = useCallback((next: string) => setQuery(next), []);

  return {
    query,
    setQuery: change,
    needle,
    hits,
    scanned,
    running,
    truncated,
  };
}
