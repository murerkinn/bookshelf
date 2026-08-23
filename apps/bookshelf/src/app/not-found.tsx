import { SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { State, StatePage } from "@/app/state";
import { BUTTON_PRIMARY } from "@/app/ui";

/**
 * Nothing at this address.
 *
 * Reached two ways: a URL that matches no route, and `notFound()` from the read
 * page, which calls it for a book the catalog does not have or a format that
 * book does not come in. The wording covers both without guessing which — a
 * shared link that has since been unpublished is the likeliest cause of either.
 */
export const metadata: Metadata = {
  title: "Not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <StatePage>
      <State
        icon={SearchX}
        title="Not on this shelf"
        actions={
          <Link href="/" className={BUTTON_PRIMARY}>
            Back to the shelf
          </Link>
        }
      >
        <p>
          There is nothing at this address. If you followed a link to a book, it
          may have been renamed or taken out of the library since.
        </p>
      </State>
    </StatePage>
  );
}
