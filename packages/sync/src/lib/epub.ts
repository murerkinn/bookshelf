import { readFile } from "node:fs/promises";
import path from "node:path";
import { bytesSource, readZipDirectory, readZipEntry } from "@bookshelf/core";
import {
  type BookMetadata,
  decodeEntities,
  elementValues,
  findIsbn,
  type ReadBook,
  splitSubjects,
  unique,
} from "./metadata.js";

const IMAGE_EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

/** Entry bodies come back as bytes; every one read here is text or an image. */
function decode(bytes: Uint8Array | null): string {
  if (!bytes) throw new Error("unreadable zip entry");
  return new TextDecoder().decode(bytes);
}

/** Resolves an EPUB-internal href against the directory holding the OPF. */
function resolvePath(base: string, href: string): string {
  const segments = base.split("/");
  segments.pop();

  for (const segment of decodeURIComponent(href).split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return segments.join("/");
}

function attribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
}

/**
 * The series a book belongs to, and where in it.
 *
 * Two conventions, both in the wild: Calibre has written `calibre:series` into
 * every book it has ever exported, and EPUB 3 specifies
 * `belongs-to-collection` with a refining `group-position`. Neither is
 * required, and a book from a series usually says so in only one of them.
 */
function findSeries(opf: string): { series?: string; seriesIndex?: number } {
  const metas = [...opf.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);

  const calibre = (name: string) =>
    metas.find(
      (meta) => attribute(meta, "name")?.toLowerCase() === `calibre:${name}`,
    );
  const series = calibre("series");
  const index = calibre("series_index");

  if (series) {
    const position = Number.parseFloat(attribute(index ?? "", "content") ?? "");
    return {
      series:
        decodeEntities(attribute(series, "content") ?? "").trim() || undefined,
      seriesIndex: Number.isFinite(position) ? position : undefined,
    };
  }

  // The EPUB 3 form identifies itself by a `property` attribute rather than by
  // its tag, so it is matched on that.
  const property = (name: string): string | undefined => {
    const pattern = new RegExp(
      `<meta\\b[^>]*\\bproperty\\s*=\\s*"${name}"[^>]*>([\\s\\S]*?)</meta>`,
      "i",
    );
    const found = opf.match(pattern)?.[1];
    return found
      ? decodeEntities(found.replace(/<[^>]+>/g, "")).trim() || undefined
      : undefined;
  };

  const collection = property("belongs-to-collection");
  if (!collection) return {};

  const position = Number.parseFloat(property("group-position") ?? "");
  return {
    series: collection,
    seriesIndex: Number.isFinite(position) ? position : undefined,
  };
}

function parseMetadata(opf: string): BookMetadata {
  const [title] = elementValues(opf, "title");
  const [publisher] = elementValues(opf, "publisher");
  const [date] = elementValues(opf, "date");
  const [language] = elementValues(opf, "language");
  const [description] = elementValues(opf, "description");
  const identifiers = elementValues(opf, "identifier");

  // `dc:subject` is one element per subject, but plenty of books put a whole
  // comma-separated list in a single one.
  const subjects = unique(
    elementValues(opf, "subject").flatMap((subject) => splitSubjects(subject)),
  );

  return {
    title,
    authors: elementValues(opf, "creator"),
    publisher,
    published: date,
    language,
    identifier: identifiers[0],
    isbn: findIsbn(identifiers),
    description,
    subjects,
    ...findSeries(opf),
  };
}

/**
 * Finds the cover in the package document: the EPUB 3 `cover-image` property,
 * then the EPUB 2 `<meta name="cover">` convention, then anything that merely
 * looks like a cover.
 */
type ManifestItem = {
  id?: string;
  href?: string;
  mediaType?: string;
  properties?: string;
};

/** A manifest item that named an image, which is all this looks at. */
type ImageItem = ManifestItem & { href: string; mediaType: string };

function findCover(opf: string): ImageItem | undefined {
  const images = [...opf.matchAll(/<item\b[^>]*>/gi)]
    .map(
      (match): ManifestItem => ({
        id: attribute(match[0], "id"),
        href: attribute(match[0], "href"),
        mediaType: attribute(match[0], "media-type"),
        properties: attribute(match[0], "properties"),
      }),
    )
    .filter(
      (item): item is ImageItem =>
        !!item.href && !!item.mediaType?.startsWith("image/"),
    );

  const byProperty = images.find((item) =>
    item.properties?.split(/\s+/).includes("cover-image"),
  );
  if (byProperty) return byProperty;

  const metaId = opf
    .match(/<meta\b[^>]*\bname\s*=\s*"cover"[^>]*>/i)?.[0]
    ?.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1];
  const byMeta = metaId && images.find((item) => item.id === metaId);
  if (byMeta) return byMeta;

  return images.find(
    (item) =>
      item.id?.toLowerCase().includes("cover") ||
      item.href?.toLowerCase().includes("cover"),
  );
}

/** Reads metadata and the cover image out of an EPUB in one pass. */
export async function readEpub(file: string): Promise<ReadBook> {
  const source = bytesSource(await readFile(file));

  const directory = await readZipDirectory(source);
  if (!directory) throw new Error("not a valid ZIP archive");

  const containerEntry = directory.get("META-INF/container.xml");
  if (!containerEntry) throw new Error("no META-INF/container.xml");

  const container = decode(await readZipEntry(source, containerEntry));
  const opfPath = container.match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]*)"/i,
  )?.[1];
  if (!opfPath) throw new Error("no rootfile in container.xml");

  const opfEntry = directory.get(opfPath);
  if (!opfEntry) throw new Error(`missing package document: ${opfPath}`);
  const opf = decode(await readZipEntry(source, opfEntry));

  const metadata = parseMetadata(opf);

  let cover: ReadBook["cover"] = null;
  const found = findCover(opf);
  if (found) {
    const coverPath = resolvePath(opfPath, found.href);
    const coverEntry = directory.get(coverPath);
    if (coverEntry) {
      const body = await readZipEntry(source, coverEntry);
      // A manifest can promise an entry the archive does not hold, and one that
      // will not decompress reads the same way: no cover rather than a failure.
      if (body) {
        cover = {
          body,
          extension:
            IMAGE_EXTENSION_BY_MEDIA_TYPE[found.mediaType] ??
            path.extname(coverPath).toLowerCase() ??
            ".jpg",
        };
      }
    }
  }

  return { metadata, cover };
}
