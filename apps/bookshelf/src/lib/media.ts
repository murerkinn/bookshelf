/**
 * The types a cover is served as: raster images, and nothing else.
 *
 * SVG is the image format left out, on purpose. It is a document rather than a
 * picture — it can carry script — and a cover URL opened on its own renders in
 * this origin. Nothing sync publishes is lost by it: the thumbnailer writes
 * WebP or JPEG, and a full-size `.svg` is stored as octet-stream, which no
 * browser would draw as an image anyway.
 */
const COVER_CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

/**
 * Content types for the files found inside an EPUB. SVG is allowed here where
 * it is not for a cover because `/book/` serves under a `sandbox` policy of its
 * own, and a chapter's illustrations are often SVG.
 */
const ENTRY_CONTENT_TYPES: Record<string, string> = {
  ...COVER_CONTENT_TYPES,
  svg: "image/svg+xml",
  xhtml: "application/xhtml+xml; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  opf: "application/oebps-package+xml; charset=utf-8",
  ncx: "application/x-dtbncx+xml; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

const COVER_EXTENSIONS = new Set(Object.keys(COVER_CONTENT_TYPES));

export function extension(path: string): string {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function isCover(path: string): boolean {
  return COVER_EXTENSIONS.has(extension(path));
}

export function coverContentType(path: string): string {
  return isCover(path)
    ? COVER_CONTENT_TYPES[extension(path)]
    : "application/octet-stream";
}

export function entryContentType(path: string): string {
  return ENTRY_CONTENT_TYPES[extension(path)] ?? "application/octet-stream";
}

/**
 * Books with no cover image get a tinted tile with their initials instead. It
 * is rendered inline by the page rather than fetched, so a coverless shelf
 * costs no extra requests.
 */
export function placeholder(title: string): { initials: string; hue: number } {
  let hue = 0;
  for (let i = 0; i < title.length; i++) {
    hue = (hue * 31 + title.charCodeAt(i)) % 360;
  }

  const initials = title
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

  return { initials, hue };
}

/**
 * The tile's background: one hue eased slightly darker toward the bottom,
 * like a lit surface rather than a two-color blend.
 */
export function tint(hue: number): string {
  return `linear-gradient(hsl(${hue} 45% 60%), hsl(${hue} 42% 51%))`;
}
