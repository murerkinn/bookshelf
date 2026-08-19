/**
 * Content types by extension.
 *
 * A provider that stores metadata alongside an object records the type at
 * upload time and hands it back on read. One that does not — a filesystem has
 * nowhere to put it — derives it from the key instead, and both arrive at the
 * same answer because they consult this table.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export function contentTypeFor(key: string): string {
  const dot = key.lastIndexOf(".");
  const extension = dot === -1 ? "" : key.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}
