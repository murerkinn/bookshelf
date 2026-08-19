import { readFile } from "node:fs/promises";
import path from "node:path";
import { readZipDirectory, readZipEntry } from "./zip.mjs";

const IMAGE_EXTENSION_BY_MEDIA_TYPE = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

/** Resolves an EPUB-internal href against the directory holding the OPF. */
function resolvePath(base, href) {
  const segments = base.split("/");
  segments.pop();

  for (const segment of decodeURIComponent(href).split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return segments.join("/");
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
}

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Package metadata is XML, so a title containing an ampersand arrives as
 * `ATT&amp;CK`. Left encoded it would be stored that way, escaped a second time
 * on render, and dragged into the book's slug as "att-amp-ck".
 */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Every value of a Dublin Core element, with markup and whitespace stripped. */
function dublinCore(opf, name) {
  // Most books namespace these as `dc:`, a few use a default namespace.
  const pattern = new RegExp(
    `<(?:dc:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:dc:)?${name}>`,
    "gi",
  );
  return [...opf.matchAll(pattern)]
    .map((match) =>
      decodeEntities(match[1].replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function parseMetadata(opf) {
  const [title] = dublinCore(opf, "title");
  const [publisher] = dublinCore(opf, "publisher");
  const [date] = dublinCore(opf, "date");
  const [language] = dublinCore(opf, "language");
  const [identifier] = dublinCore(opf, "identifier");
  const [description] = dublinCore(opf, "description");

  return {
    title,
    authors: dublinCore(opf, "creator"),
    publisher,
    published: date,
    language,
    identifier,
    description,
  };
}

/**
 * Finds the cover in the package document: the EPUB 3 `cover-image` property,
 * then the EPUB 2 `<meta name="cover">` convention, then anything that merely
 * looks like a cover.
 */
function findCover(opf) {
  const images = [...opf.matchAll(/<item\b[^>]*>/gi)]
    .map((match) => ({
      id: attribute(match[0], "id"),
      href: attribute(match[0], "href"),
      mediaType: attribute(match[0], "media-type"),
      properties: attribute(match[0], "properties"),
    }))
    .filter((item) => item.href && item.mediaType?.startsWith("image/"));

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
export async function readEpub(file) {
  const buffer = await readFile(file);

  const directory = readZipDirectory(buffer);
  if (!directory) throw new Error("not a valid ZIP archive");

  const containerEntry = directory.get("META-INF/container.xml");
  if (!containerEntry) throw new Error("no META-INF/container.xml");

  const container = readZipEntry(buffer, containerEntry).toString("utf8");
  const opfPath = container.match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*"([^"]*)"/i,
  )?.[1];
  if (!opfPath) throw new Error("no rootfile in container.xml");

  const opfEntry = directory.get(opfPath);
  if (!opfEntry) throw new Error(`missing package document: ${opfPath}`);
  const opf = readZipEntry(buffer, opfEntry).toString("utf8");

  const metadata = parseMetadata(opf);

  let cover = null;
  const found = findCover(opf);
  if (found) {
    const coverPath = resolvePath(opfPath, found.href);
    const coverEntry = directory.get(coverPath);
    if (coverEntry) {
      cover = {
        body: readZipEntry(buffer, coverEntry),
        extension:
          IMAGE_EXTENSION_BY_MEDIA_TYPE[found.mediaType] ??
          path.extname(coverPath).toLowerCase() ??
          ".jpg",
      };
    }
  }

  return { metadata, cover };
}
