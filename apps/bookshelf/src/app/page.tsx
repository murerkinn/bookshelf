import { CloudOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ProfileMenu } from "@/app/profile-menu";
import { SearchInput } from "@/app/search-input";
import { State } from "@/app/state";
import { BUTTON_PRIMARY, BUTTON_QUIET } from "@/app/ui";
import { encodeKey } from "@/lib/http";
import { placeholder, tint } from "@/lib/media";
import { type Book, bookKey, readableFormat } from "@/services/catalog";
import { getServices } from "@/services/container";
import { ifAvailable } from "@/services/errors";
import { activeProfile } from "@/services/session";

const COVER_CLASS = "h-15 w-10 shrink-0 rounded ring-1 ring-separator";

/**
 * Searching filters through `?q=`, and every one of those is the same shelf
 * seen through a slot. The canonical points at the whole thing so a search
 * someone happened to share is not indexed as a page of its own.
 */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }

  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function Cover({ book }: { book: Book }) {
  if (book.cover) {
    return (
      // biome-ignore lint/performance/noImgElement: bucket object served by the Worker, not a static asset
      <img
        src={`/cover/${encodeKey(bookKey(book.id, book.cover))}`}
        alt=""
        width={40}
        height={60}
        loading="lazy"
        decoding="async"
        className={`${COVER_CLASS} object-cover`}
      />
    );
  }

  const { initials, hue } = placeholder(book.title);

  return (
    <div
      aria-hidden="true"
      className={`${COVER_CLASS} flex items-center justify-center text-sm font-semibold text-white/90`}
      style={{
        backgroundImage: tint(hue),
      }}
    >
      {initials}
    </div>
  );
}

export default async function Home(props: PageProps<"/">) {
  const { q } = await props.searchParams;
  const query = typeof q === "string" ? q : "";

  const here = query ? `/?q=${encodeURIComponent(query)}` : "/";
  const { catalog, profiles, progress } = await getServices();

  /*
   * Who is reading, and how far they got, are not worth a shelf for. Both come
   * out of the library, so both can be unreachable while the catalog is not —
   * and a shelf of books with no profile chip and no Continue buttons is a far
   * better answer than no shelf.
   */
  const profile = await ifAvailable(() => activeProfile());
  const [everyone, positions] = await Promise.all([
    ifAvailable(() => profiles.list()),
    profile ? ifAvailable(() => progress.all(profile.id)) : undefined,
  ]);

  // The catalog is the shelf, so this is the one read the page cannot do
  // without — but it still degrades to a state that can say what happened
  // rather than to the error boundary.
  const shelf = await ifAvailable(async () => {
    const [matching, all] = await Promise.all([
      catalog.search(query),
      catalog.all(),
    ]);
    return { matching, total: all.length };
  });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Bookshelf</h1>

        {profile && everyone && (
          <ProfileMenu
            profiles={everyone}
            activeId={profile.id}
            writable={profiles.writable}
            from={here}
          />
        )}
      </div>

      {!shelf ? (
        <div className="mt-20">
          <State
            icon={CloudOff}
            title="The library is unreachable"
            actions={
              // A plain anchor rather than a Link: the point is a fresh request
              // rather than whatever the router already has.
              <a href={here} className={BUTTON_PRIMARY}>
                Try again
              </a>
            }
          >
            <p>
              Your books are where they were — this shelf just cannot read them
              at the moment. Nothing has been lost, and nobody&rsquo;s reading
              position has been touched.
            </p>
          </State>
        </div>
      ) : (
        <>
          <SearchInput query={query} />

          {!profile && (
            <p className="mt-6 rounded-xl bg-fill px-4 py-3 text-sm text-secondary">
              Profiles could not be read just now, so this is the shelf without
              them — every book is here, but not where anyone got to in it.
            </p>
          )}

          {shelf.matching.length === 0 ? (
            <p className="mt-10 text-secondary">
              {shelf.total === 0
                ? "No catalog published yet. Run the publish script and upload its output."
                : `No books match “${query}”.`}
            </p>
          ) : (
            <ul className="mt-10 divide-y divide-separator">
              {shelf.matching.map((book) => {
                const readable = readableFormat(book);

                return (
                  <li
                    key={book.id}
                    className="flex items-center justify-between gap-6 py-4"
                  >
                    <div className="flex min-w-0 items-center gap-4">
                      <Cover book={book} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{book.title}</p>
                        <p className="mt-1 truncate text-sm text-secondary">
                          {book.authors.join(", ")}
                        </p>
                        <p className="mt-0.5 truncate text-xs text-tertiary">
                          {[
                            book.published?.slice(0, 4),
                            book.publisher,
                            book.formats
                              .map(
                                (f) =>
                                  `${f.format.toUpperCase()} ${formatSize(f.size)}`,
                              )
                              .join(" · "),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      {readable && (
                        <Link
                          href={`/read/${encodeKey(bookKey(book.id, readable.file))}`}
                          className={BUTTON_PRIMARY}
                        >
                          {positions?.[book.id] ? "Continue" : "Read"}
                        </Link>
                      )}
                      {book.formats.map((format) => (
                        <a
                          key={format.file}
                          href={`/download/${encodeKey(bookKey(book.id, format.file))}`}
                          download
                          className={BUTTON_QUIET}
                        >
                          {format.format.toUpperCase()}
                        </a>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
