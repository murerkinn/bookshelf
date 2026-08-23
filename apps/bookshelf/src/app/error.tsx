"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { State, StatePage } from "@/app/state";
import { BUTTON, BUTTON_PRIMARY } from "@/app/ui";

/**
 * The last resort: something threw where nothing expected it to.
 *
 * The expected failures do not arrive here. A library that cannot be reached is
 * answered by the shelf itself, which knows to say so and to offer what it can
 * still show; a book that is not there is a `notFound()`. What is left is a bug
 * or an outage nobody accounted for, and the honest thing is to say so plainly
 * rather than to guess at a cause.
 *
 * The message deliberately is not shown. Next redacts a server error's message
 * in production and hands over a digest instead, so anything displayed here
 * would read as detail in development and as nothing at all in production —
 * which is the wrong way round. The digest is shown, because it is the one thing
 * that ties what a reader saw to what the logs recorded.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The server logs its own; this is the browser's copy, for a failure that
    // happened after the page was handed over.
    console.error(error);
  }, [error]);

  return (
    <StatePage>
      <State
        icon={TriangleAlert}
        title="Something went wrong"
        footnote={error.digest}
        actions={
          <>
            <button
              type="button"
              onClick={reset}
              className={`${BUTTON_PRIMARY} inline-flex items-center gap-1.5`}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Try again
            </button>
            <Link href="/" className={BUTTON}>
              Back to the shelf
            </Link>
          </>
        }
      >
        <p>
          This page could not be shown. Trying again is worth a go — if it keeps
          happening, the server log will have the details.
        </p>
      </State>
    </StatePage>
  );
}
