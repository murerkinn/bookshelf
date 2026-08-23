"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { State } from "@/app/state";
import { BUTTON_PRIMARY } from "@/app/ui";
import "./globals.css";

/**
 * When the layout itself is what failed.
 *
 * `error.tsx` renders inside the root layout, so it cannot help if the layout is
 * what threw. This replaces the document instead, which is why it carries its
 * own `<html>` and `<body>` and imports the stylesheet — nothing above it ran.
 *
 * A plain anchor rather than a `Link`, and a reload rather than `reset`: the
 * router is part of what may be broken, and this page's one job is to be the
 * thing that still works.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">
        <main className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center px-6 py-16">
          <State
            icon={TriangleAlert}
            title="Bookshelf could not start"
            footnote={error.digest}
            actions={
              <a href="/" className={BUTTON_PRIMARY}>
                Reload
              </a>
            }
          >
            <p>
              Something failed before the page could be built. If a reload does
              not help, the server log will say what.
            </p>
          </State>
        </main>
      </body>
    </html>
  );
}
