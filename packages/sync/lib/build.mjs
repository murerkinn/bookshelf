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
import { CATALOG_FILE, CATALOG_VERSION, METADATA_FILE } from "@bookshelf/core";
import { BOOK_EXTENSIONS } from "./config.mjs";
import { readEpub } from "./epub.mjs";
import { findRasteriser } from "./images.mjs";

function slugify(value) {
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
async function place(source, target) {
  await rm(target, { force: true });
  try {
    await link(source, target);
  } catch {
    await copyFile(source, target);
  }
}

async function collect(directory) {
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
function groupByBook(files) {
  const groups = new Map();
  for (const file of files) {
    const stem = file.slice(0, -path.extname(file).length);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(file);
  }
  return [...groups.values()];
}

async function publishBook(files, outDir, options, thumb, ids, index) {
  const epub = files.find((f) => path.extname(f).toLowerCase() === ".epub");
  const fallbackTitle = path.basename(files[0], path.extname(files[0]));

  let metadata = { title: fallbackTitle, authors: [] };
  let cover = null;

  if (epub) {
    const read = await readEpub(epub);
    metadata = { ...read.metadata };
    if (!metadata.title) metadata.title = fallbackTitle;
    cover = read.cover;
  }

  // A slug from the title reads well when browsing the bucket directly, which
  // is much of the point of keeping the library as plain files.
  let id = slugify(metadata.title);
  if (ids.has(id)) {
    let n = 2;
    while (ids.has(`${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  ids.add(id);

  const folder = path.join(outDir, id);
  await mkdir(folder, { recursive: true });

  const formats = [];
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

  let coverFile;
  let temporary = null;
  try {
    if (!cover && !epub) {
      // A PDF-only book: render its first page instead.
      const rasterise = await findRasteriser();
      if (rasterise) {
        temporary = path.join(
          tmpdir(),
          `bookshelf-${process.pid}-${index}.png`,
        );
        await rasterise(files[0], temporary);
        cover = { path: temporary, extension: ".png" };
      }
    } else if (cover) {
      temporary = path.join(
        tmpdir(),
        `bookshelf-${process.pid}-${index}${cover.extension}`,
      );
      await writeFile(temporary, cover.body);
      cover = { path: temporary, extension: cover.extension };
    }

    if (cover) {
      if (thumb) {
        coverFile = `cover${thumb.extension}`;
        await thumb.convert(
          cover.path,
          path.join(folder, coverFile),
          options.height,
        );
      } else {
        coverFile = `cover${cover.extension}`;
        await place(cover.path, path.join(folder, coverFile));
      }
    }
  } finally {
    if (temporary) await rm(temporary, { force: true });
  }

  const book = {
    id,
    title: metadata.title,
    authors: metadata.authors ?? [],
    publisher: metadata.publisher,
    published: metadata.published,
    language: metadata.language,
    identifier: metadata.identifier,
    description: metadata.description,
    cover: coverFile,
    formats,
  };

  await writeFile(
    path.join(folder, METADATA_FILE),
    `${JSON.stringify(book, null, 2)}\n`,
  );

  return book;
}

/**
 * Builds the upload tree: one folder per book holding every format of it, its
 * cover and its metadata, plus a catalog concatenating them all.
 */
export async function buildLibrary(inputDir, outDir, options, thumb, log) {
  const files = await collect(inputDir);
  const groups = groupByBook(files).sort((a, b) => a[0].localeCompare(b[0]));
  if (groups.length === 0) {
    throw new Error(`no .epub or .pdf files found in ${inputDir}`);
  }

  // Rebuilt from scratch so a removed book cannot linger in the tree and get
  // re-uploaded forever.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const books = [];
  const ids = new Set();
  let failed = 0;
  let index = 0;

  for (const group of groups) {
    index++;
    try {
      const book = await publishBook(group, outDir, options, thumb, ids, index);
      books.push(book);
      log(
        `  ok     ${book.id}  (${book.formats.map((f) => f.format).join(", ")})` +
          `${book.cover ? "" : "  [no cover]"}`,
      );
    } catch (error) {
      failed++;
      log(`  fail   ${path.basename(group[0])} (${error.message})`);
    }
  }

  const catalog = {
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
