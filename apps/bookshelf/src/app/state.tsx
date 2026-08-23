import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A page that is not showing what it was asked for: a book that is not there, a
 * library that cannot be reached, something that went wrong.
 *
 * One component for all of them because they are one thing wearing different
 * words, and because the alternative is three pages that drift apart. It is
 * deliberately plain — a glyph, a line, a sentence, a way out. The palette
 * already commits to surfaces made of fills rather than borders and shadows, so
 * a state does not need a card around it to read as one.
 *
 * No directive: this is markup, and it is rendered from `not-found.tsx` on the
 * server and from `error.tsx` in the browser.
 */
export function State({
  icon: Icon,
  title,
  children,
  actions,
  footnote,
}: {
  icon: LucideIcon;
  title: string;
  /** A sentence or two. Kept to a narrow measure, so it reads as one. */
  children: ReactNode;
  actions?: ReactNode;
  /** Anything a reader would only want if they were reporting it. */
  footnote?: ReactNode;
}) {
  return (
    <div className="text-center">
      <span
        aria-hidden="true"
        className="mx-auto flex size-14 items-center justify-center rounded-full bg-fill"
      >
        <Icon className="size-7 text-secondary" strokeWidth={1.5} />
      </span>

      {/* A step down from a page heading, because this is a state rather than a
          page — the same reason it is centered and a shelf is not. */}
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">{title}</h1>

      <div className="mx-auto mt-2 max-w-md text-secondary text-balance">
        {children}
      </div>

      {actions && (
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          {actions}
        </div>
      )}

      {footnote && (
        <p className="mt-8 font-mono text-xs text-tertiary">{footnote}</p>
      )}
    </div>
  );
}

/**
 * The shell a state sits in on a page of its own, centred in whatever height is
 * left. `flex-1` is what the body's column layout hands it.
 */
export function StatePage({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center px-6 py-16">
      {children}
    </main>
  );
}
