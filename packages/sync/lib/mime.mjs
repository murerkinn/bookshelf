const CONTENT_TYPES = {
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

/**
 * Objects are uploaded with a content type so the app can serve them without
 * having to guess from the key.
 */
export function contentTypeFor(file) {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}
