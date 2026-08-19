import Link from "next/link";
import { notFound } from "next/navigation";
import { EpubReader } from "@/app/read/[...key]/epub-reader";
import { extension } from "@/lib/media";
import { getServices } from "@/services/container";
import { activeProfile } from "@/services/session";

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
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
      <header className="flex items-center justify-between gap-4 border-b border-black/10 px-6 py-3 dark:border-white/10">
        <Link
          href="/"
          className="shrink-0 text-sm font-medium text-zinc-500 hover:text-inherit"
        >
          ← Shelf
        </Link>
        <h1 className="min-w-0 truncate text-sm font-medium">{book.title}</h1>
        <a
          href={`/download/${encodeKey(fileKey)}`}
          download
          className="shrink-0 text-sm font-medium text-zinc-500 hover:text-inherit"
        >
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
