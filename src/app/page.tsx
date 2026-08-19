import Link from "next/link";
import { SearchInput } from "@/app/search-input";
import { placeholder } from "@/lib/media";
import { type Book, bookKey, readableFormat } from "@/services/catalog";
import { getServices } from "@/services/container";

const COVER_CLASS =
  "h-15 w-10 shrink-0 rounded shadow-sm ring-1 ring-black/10 dark:ring-white/10";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

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
        backgroundImage: `linear-gradient(hsl(${hue} 42% 58%), hsl(${(hue + 40) % 360} 44% 38%))`,
      }}
    >
      {initials}
    </div>
  );
}

export default async function Home(props: PageProps<"/">) {
  const { q } = await props.searchParams;
  const query = typeof q === "string" ? q : "";

  const { catalog } = await getServices();
  const books = await catalog.search(query);
  const empty = (await catalog.all()).length === 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Bookshelf</h1>

      <SearchInput query={query} />

      {books.length === 0 ? (
        <p className="mt-10 text-zinc-500">
          {empty
            ? "No catalog published yet. Run the publish script and upload its output."
            : `No books match “${query}”.`}
        </p>
      ) : (
        <ul className="mt-10 divide-y divide-black/10 dark:divide-white/10">
          {books.map((book) => {
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
                    <p className="mt-1 truncate text-sm text-zinc-500">
                      {book.authors.join(", ")}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-zinc-400">
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
                      className="rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
                    >
                      Read
                    </Link>
                  )}
                  {book.formats.map((format) => (
                    <a
                      key={format.file}
                      href={`/download/${encodeKey(bookKey(book.id, format.file))}`}
                      download
                      className="rounded-lg px-2 py-1.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-black/5 hover:text-inherit dark:hover:bg-white/10"
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
    </main>
  );
}
