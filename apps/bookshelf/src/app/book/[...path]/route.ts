import { parseBookKey } from "@bookshelf/core";
import { serviceUnavailable } from "@/lib/http";
import { entryContentType } from "@/lib/media";
import { enforceR2RateLimit } from "@/lib/rate-limit";
import { getServices } from "@/services/container";
import { optional } from "@/services/errors";

/**
 * A book's contents are fixed for a given key, and the reader re-requests
 * chapters as the user moves around, so these are worth caching hard.
 */
const MAX_AGE_SECONDS = 604800;

/**
 * Splits `/book/<book file key>/<entry path>` into its two halves. Both contain
 * slashes, so the boundary is the first segment ending in `.epub` — unambiguous
 * because the entry path lives inside that archive.
 */
function split(segments: string[]): { key: string; entryPath: string } | null {
  const boundary = segments.findIndex((segment) =>
    segment.toLowerCase().endsWith(".epub"),
  );
  if (boundary === -1 || boundary === segments.length - 1) return null;

  const key = segments.slice(0, boundary + 1).join("/");
  // The same rule the other two byte routes apply: the archive named here is a
  // file inside a book's folder, not any object in the bucket that happens to
  // end in `.epub`. The entry path within it needs no such check — it is
  // matched against the archive's own directory, which cannot name anything
  // outside itself.
  if (!parseBookKey(key)) return null;

  return {
    key,
    entryPath: segments.slice(boundary + 1).join("/"),
  };
}

/**
 * Serves a single file from inside an EPUB, letting the reader fetch chapters
 * one at a time instead of downloading a whole book to show its first page.
 */
export async function GET(
  request: Request,
  routeContext: RouteContext<"/book/[...path]">,
) {
  const { path } = await routeContext.params;
  const target = split(path);
  if (!target) {
    return new Response("Not found", { status: 404 });
  }

  const { content, cache, limits } = await getServices();

  const cacheKey = request.url;
  const hit = await optional(() => cache.match(cacheKey));
  if (hit) return hit;

  // After the cache for the same reason as the covers: a reader moving through
  // a book asks for one chapter after another, and the ones already held here
  // cost the bucket nothing. What is left is a genuine read of the archive.
  const limited = await enforceR2RateLimit(request, limits);
  if (limited) return limited;

  // Null is a chapter this book does not have, which is a 404. A library that
  // could not be reached is not, and `serviceUnavailable` tells them apart.
  let body: Uint8Array<ArrayBuffer> | null;
  try {
    body = await content.entry(target.key, target.entryPath);
  } catch (error) {
    return serviceUnavailable(error);
  }
  if (!body) {
    return new Response("Not found", { status: 404 });
  }

  const response = new Response(body, {
    headers: {
      "content-type": entryContentType(target.entryPath),
      "content-length": String(body.byteLength),
      "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
      // Book markup is untrusted. The reader renders it in a sandboxed iframe
      // without scripting, and this keeps that true for anyone who opens one of
      // these URLs directly.
      "content-security-policy": "sandbox allow-same-origin",
      "x-content-type-options": "nosniff",
    },
  });

  void optional(async () => cache.put(cacheKey, response.clone()));
  return response;
}
