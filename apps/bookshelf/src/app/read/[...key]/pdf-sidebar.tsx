"use client";

import { Search as SearchIcon, X } from "lucide-react";
import { useId, useMemo } from "react";
import type { OutlineEntry } from "@/app/read/[...key]/pdf-document";
import type { Search } from "@/app/read/[...key]/pdf-search";
import { INPUT } from "@/app/ui";

export type Panel = "contents" | "search";

/**
 * The panel beside the page: what the book is made of, and what it says.
 *
 * Both are lists of places to go, which is why they share a drawer rather than
 * each getting their own — and why the drawer is a drawer at all. A PDF's
 * outline runs to hundreds of entries in a technical book, which is more than a
 * dropdown can show and exactly what a column of text is good at.
 */
export function PdfSidebar({
  panel,
  outline,
  page,
  search,
  onGo,
  onClose,
}: {
  panel: Panel;
  outline: OutlineEntry[];
  /** The page being read, so the contents can say where that is. */
  page: number;
  search: Search;
  onGo: (page: number) => void;
  onClose: () => void;
}) {
  const field = useId();

  /**
   * The last entry at or before the current page — the section being read.
   *
   * Entries are in document order, so this is the deepest bookmark whose page
   * has been passed. Ties go to the later entry, which is the more specific one.
   * Answered as an id rather than as a position in the list, so that it means
   * the same thing as the key each row is drawn with.
   */
  const here = useMemo(() => {
    let found: number | null = null;
    for (const entry of outline) {
      if (entry.page !== null && entry.page <= page) found = entry.id;
    }
    return found;
  }, [outline, page]);

  return (
    <aside
      aria-label={panel === "contents" ? "Contents" : "Search in this book"}
      className="flex w-72 shrink-0 flex-col border-r border-separator bg-background"
    >
      {panel === "search" ? (
        <div className="border-b border-separator p-3">
          <label htmlFor={field} className="sr-only">
            Search in this book
          </label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-tertiary"
            />
            <input
              id={field}
              type="search"
              value={search.query}
              onChange={(event) => search.setQuery(event.target.value)}
              placeholder="Search in this book"
              // The reader's own shortcuts would otherwise turn the page from
              // inside the search box.
              onKeyDown={(event) => event.stopPropagation()}
              className={`${INPUT} w-full pl-8`}
            />
          </div>
          <p className="mt-2 min-h-4 px-0.5 text-xs text-tertiary">
            <SearchStatus search={search} />
          </p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
        {panel === "contents" ? (
          outline.length === 0 ? (
            <Empty>
              This PDF carries no bookmarks, so there is no contents to show.
              The page box in the toolbar goes anywhere in it.
            </Empty>
          ) : (
            <ul>
              {outline.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    disabled={entry.page === null}
                    onClick={() => entry.page !== null && onGo(entry.page)}
                    aria-current={entry.id === here ? "true" : undefined}
                    className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[13px] leading-snug transition-colors enabled:hover:bg-fill disabled:text-tertiary ${
                      entry.id === here
                        ? "font-medium text-accent"
                        : "text-secondary"
                    }`}
                    style={{ paddingLeft: `${0.75 + entry.depth * 0.875}rem` }}
                  >
                    <span className="min-w-0 flex-1">{entry.title}</span>
                    {entry.page !== null && (
                      <span className="shrink-0 text-xs tabular-nums text-tertiary">
                        {entry.page}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : search.needle === "" ? (
          <Empty>Type at least two letters to search the whole book.</Empty>
        ) : search.hits.length === 0 && !search.running ? (
          <Empty>Nothing in this book matches “{search.query.trim()}”.</Empty>
        ) : (
          <ul>
            {search.hits.map((hit) => (
              <li key={`${hit.page}-${hit.at}`}>
                <button
                  type="button"
                  onClick={() => onGo(hit.page)}
                  className="w-full px-3 py-2 text-left transition-colors hover:bg-fill"
                >
                  <span className="mb-0.5 block text-xs tabular-nums text-tertiary">
                    Page {hit.page}
                  </span>
                  <span className="block text-[13px] leading-snug text-secondary">
                    {hit.before}
                    <mark className="rounded-[3px] bg-accent/20 text-foreground">
                      {hit.match}
                    </mark>
                    {hit.after}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="flex items-center justify-center gap-1.5 border-t border-separator px-3 py-2 text-xs font-medium text-secondary transition-colors hover:bg-fill hover:text-foreground"
      >
        <X aria-hidden="true" className="size-3.5" />
        Hide
      </button>
    </aside>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-3 text-[13px] leading-relaxed text-tertiary">
      {children}
    </p>
  );
}

function SearchStatus({ search }: { search: Search }) {
  if (search.needle === "") return null;

  const count = search.hits.length;
  const found = `${count} ${count === 1 ? "result" : "results"}`;

  if (search.truncated) return `${found} — more than shown, so narrow it down`;
  if (search.running)
    return `${found} so far, searching page ${search.scanned}`;
  return found;
}
