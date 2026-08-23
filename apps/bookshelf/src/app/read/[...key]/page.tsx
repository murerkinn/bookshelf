import { ArrowDownToLine, ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EpubReader } from "@/app/read/[...key]/epub-reader";
import { extension } from "@/lib/media";
import { OG_BASE } from "@/lib/site";
import { bookKey } from "@/services/catalog";
import { getServices } from "@/services/container";
import { activeProfile } from "@/services/session";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * What a shared book link says about itself.
 *
 * The cover stands in for the OG image, so passing a book to someone shows the
 * book rather than the shelf it came from. It is a portrait image and a large
 * summary card would letterbox it, hence the smaller card here.
 *
 * Reading positions live behind this URL and a library is not a publication, so
 * the page asks not to be indexed. It stays crawlable rather than disallowed in
 * robots.txt, which is what lets a preview be built at all.
 */
export async function generateMetadata(
  props: PageProps<"/read/[...key]">,
): Promise<Metadata> {
  const { key } = await props.params;
  const fileKey = key.join("/");
  const [id] = fileKey.split("/");

  // The catalog is memoised per request, so the page's own lookup is free.
  const { catalog } = await getServices();
  const book = await catalog.find(id);
  if (!book) return { robots: { index: false, follow: false } };

  const authors = book.authors.join(", ");
  const cover = book.cover
    ? {
        url: `/cover/${encodeKey(bookKey(book.id, book.cover))}`,
        alt: book.title,
      }
    : undefined;

  return {
    title: book.title,
    description: authors ? `${book.title} by ${authors}` : book.title,
    robots: { index: false, follow: false },
    openGraph: {
      ...OG_BASE,
      type: "book",
      authors: book.authors,
      title: book.title,
      description: authors,
      url: `/read/${encodeKey(fileKey)}`,
      ...(cover ? { images: [cover] } : {}),
    },
    twitter: {
      card: "summary",
      title: book.title,
      description: authors,
      ...(cover ? { images: [cover] } : {}),
    },
  };
}

export default async function ReadPage(props: PageProps<"/read/[...key]">) {
  const { key } = await props.params;
  const fileKey = key.join("/");
  const [id] = fileKey.split("/");

  const { catalog } = await getServices();
  const book = await catalog.find(id);
  if (!book || !book.formats.some((f) => fileKey.endsWith(`/${f.file}`))) {
    notFound();
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-separator px-6 py-3">
        <Link
          href="/"
          className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-secondary transition-colors hover:text-foreground"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          Shelf
        </Link>
        <h1 className="min-w-0 truncate text-sm font-medium">{book.title}</h1>
        <a
          href={`/download/${encodeKey(fileKey)}`}
          download
          className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-secondary transition-colors hover:text-foreground"
        >
          <ArrowDownToLine aria-hidden="true" className="size-4" />
          Download
        </a>
      </header>

      {extension(fileKey) === "epub" ? (
        <EpubBody fileKey={fileKey} bookId={book.id} />
      ) : (
        // Anything else is handed to the browser's own viewer. PDFs render
        // natively; the inline disposition is what stops it downloading.
        <iframe
          src={`/download/${encodeKey(fileKey)}?inline=1`}
          title={book.title}
          className="flex-1 border-0"
        />
      )}
    </div>
  );
}

async function EpubBody({
  fileKey,
  bookId,
}: {
  fileKey: string;
  bookId: string;
}) {
  const { content, progress } = await getServices();
  const profile = await activeProfile();

  const [opfPath, saved] = await Promise.all([
    // Resolving the package document also proves the archive is readable
    // before the reader is handed anything.
    content.packageDocument(fileKey),
    progress.get(profile.id, bookId),
  ]);
  if (!opfPath) notFound();

  return (
    <EpubReader
      opfUrl={`/book/${encodeKey(fileKey)}/${encodeKey(opfPath)}`}
      bookKey={fileKey}
      bookId={bookId}
      profileId={profile.id}
      saved={saved}
      canSync={progress.writable}
    />
  );
}
