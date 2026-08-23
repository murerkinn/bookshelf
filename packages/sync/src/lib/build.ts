import {
  copyFile,
  link,
  mkdir,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Book,
  type BookFormat,
  CATALOG_FILE,
  CATALOG_VERSION,
  type Catalog,
  METADATA_FILE,
} from "@bookshelf/core";
import { BOOK_EXTENSIONS } from "./config.js";
import { readEpub } from "./epub.js";
import { findRasteriser, type Thumbnailer } from "./images.js";
import type { BookMetadata } from "./metadata.js";
import { readPdf } from "./pdf.js";
import { messageOf } from "./util.js";

export type BuildOptions = {
  /** Cover thumbnail height, in pixels. */
  height: number;
};

export type BuildResult = {
  books: Book[];
  /** Files that looked like books and could not be read as one. */
  failed: number;
};

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "book";
}

/** Hard-links where possible; a cross-device link falls back to copying. */
async function place(source: string, target: string): Promise<void> {
  await rm(target, { force: true });
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
    recursive: true,
  });

  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        BOOK_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        // macOS AppleDouble sidecars carry the book's extension but hold only
        // 4 KB of extended attributes.
        !entry.name.startsWith("._"),
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/** Files sharing a name but differing in extension are formats of one book. */
function groupByBook(files: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const stem = file.slice(0, -path.extname(file).length);
    const group = groups.get(stem);
    if (group) group.push(file);
    else groups.set(stem, [file]);
  }
  return [...groups.values()];
}

async function publishBook(
  files: readonly string[],
  outDir: string,
  options: BuildOptions,
  thumb: Thumbnailer | null,
  ids: Set<string>,
  index: number,
): Promise<{ book: Book; encrypted: boolean }> {
  const extensionOf = (file: string) => path.extname(file).toLowerCase();
  const epub = files.find((file) => extensionOf(file) === ".epub");
  const pdf = files.find((file) => extensionOf(file) === ".pdf");
  const fallbackTitle = path.basename(files[0], path.extname(files[0]));

  // Both formats record what they know about themselves, and the EPUB records
  // it better — so where a book is published in both, the EPUB is what is read.
  const read = epub ? await readEpub(epub) : pdf ? await readPdf(pdf) : null;
  const metadata: BookMetadata = read?.metadata ?? { authors: [] };
  const encrypted = read?.encrypted ?? false;

  // A format that recorded no usable title falls back to the file name, which is
  // where a title came from before any format was read at all.
  const title = metadata.title || fallbackTitle;

  // A slug from the title reads well when browsing the bucket directly, which
  // is much of the point of keeping the library as plain files.
  let id = slugify(title);
  if (ids.has(id)) {
    let n = 2;
    while (ids.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  ids.add(id);

  const folder = path.join(outDir, id);
  await mkdir(folder, { recursive: true });

  const formats: BookFormat[] = [];
  for (const file of [...files].sort()) {
    const extension = path.extname(file).toLowerCase();
    const name = `${id}${extension}`;
    await place(file, path.join(folder, name));
    formats.push({
      format: extension.slice(1),
      file: name,
      size: (await stat(file)).size,
    });
  }

  let coverFile: string | undefined;
  let temporary: string | null = null;
  // The cover as a file on disk, which is what both the thumbnailer and the
  // plain copy work from. What the reader handed back is bytes, and a PDF's is
  // not read at all but rendered, so the two paths meet here rather than in a
  // variable that means one thing and then the other.
  let source: { path: string; extension: string } | null = null;
  try {
    if (!read?.cover && pdf) {
      // A PDF's cover is its first page, so it is rendered rather than read.
      const rasterise = await findRasteriser();
      if (rasterise) {
        temporary = path.join(
          tmpdir(),
          `bookshelf-${process.pid}-${index}.png`,
        );
        await rasterise(pdf, temporary);
        source = { path: temporary, extension: ".png" };
      }
    } else if (read?.cover) {
      temporary = path.join(
        tmpdir(),
        `bookshelf-${process.pid}-${index}${read.cover.extension}`,
      );
      await writeFile(temporary, read.cover.body);
      source = { path: temporary, extension: read.cover.extension };
    }

    if (source) {
      if (thumb) {
        coverFile = `cover${thumb.extension}`;
        await thumb.convert(
          source.path,
          path.join(folder, coverFile),
          options.height,
        );
      } else {
        coverFile = `cover${source.extension}`;
        await place(source.path, path.join(folder, coverFile));
      }
    }
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }

  const book: Book = {
    id,
    title,
    authors: metadata.authors ?? [],
    publisher: metadata.publisher,
    published: metadata.published,
    language: metadata.language,
    identifier: metadata.identifier,
    isbn: metadata.isbn,
    description: metadata.description,
    // Omitted rather than written empty, so a book that records no subjects
    // does not carry a field saying so.
    subjects: metadata.subjects?.length ? metadata.subjects : undefined,
    series: metadata.series,
    seriesIndex: metadata.seriesIndex,
    pages: metadata.pages,
    cover: coverFile,
    formats,
  };

  await writeFile(
    path.join(folder, METADATA_FILE),
    `${JSON.stringify(book, null, 2)}\n`,
  );

  return { book, encrypted };
}

/**
 * Builds the upload tree: one folder per book holding every format of it, its
 * cover and its metadata, plus a catalog concatenating them all.
 */
export async function buildLibrary(
  inputDir: string,
  outDir: string,
  options: BuildOptions,
  thumb: Thumbnailer | null,
  log: (message: string) => void,
): Promise<BuildResult> {
  const files = await collect(inputDir);
  const groups = groupByBook(files).sort((a, b) => a[0].localeCompare(b[0]));
  if (groups.length === 0) {
    throw new Error(`no .epub or .pdf files found in ${inputDir}`);
  }

  // Rebuilt from scratch so a removed book cannot linger in the tree and get
  // re-uploaded forever.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const books: Book[] = [];
  const ids = new Set<string>();
  let failed = 0;
  let index = 0;

  for (const group of groups) {
    index++;
    try {
      const { book, encrypted } = await publishBook(
        group,
        outDir,
        options,
        thumb,
        ids,
        index,
      );
      books.push(book);
      log(
        `  ok     ${book.id}  (${book.formats.map((f) => f.format).join(", ")})` +
          `${book.cover ? "" : "  [no cover]"}` +
          // An encrypted PDF has readable structure and unreadable strings, so
          // its metadata is missing for a reason worth naming rather than
          // looking like a book that recorded nothing.
          `${encrypted ? "  [encrypted, no metadata]" : ""}`,
      );
    } catch (error) {
      failed++;
      log(`  fail   ${path.basename(group[0])} (${messageOf(error)})`);
    }
  }

  const catalog: Catalog = {
    version: CATALOG_VERSION,
    generatedAt: new Date().toISOString(),
    books: books.sort((a, b) => a.title.localeCompare(b.title)),
  };
  await writeFile(
    path.join(outDir, CATALOG_FILE),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );

  return { books, failed };
}
