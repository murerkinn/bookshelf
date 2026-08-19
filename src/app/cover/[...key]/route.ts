import { imageContentType, isImage } from "@/lib/media";
import { getServices } from "@/services/container";

/**
 * A day, rather than `immutable`. Covers only change when one is re-uploaded to
 * correct it, and that correction should become visible without waiting a year
 * — the ETag below makes the revalidation a 304 rather than a re-download.
 */
const MAX_AGE_SECONDS = 86400;

/** Bare entity tag, with any weak marker and quotes removed. */
function normaliseEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/"/g, "");
}

/**
 * Serves a cover image out of the private bucket. The key comes from the book's
 * metadata — books without a cover get an inline placeholder from the page
 * instead of a request here.
 */
export async function GET(
  request: Request,
  routeContext: RouteContext<"/cover/[...key]">,
) {
  const { key } = await routeContext.params;
  const objectKey = key.join("/");

  if (!isImage(objectKey)) {
    return new Response("Not found", { status: 404 });
  }

  const { storage, cache } = await getServices();

  // Keyed by URL rather than the Request: under OpenNext this handler receives
  // a NextRequest wrapper, which the Cache API cannot use as a key.
  const cacheKey = request.url;
  const conditional = request.headers.get("if-none-match");

  const hit = await cache.match(cacheKey);
  if (hit) {
    const etag = hit.headers.get("etag");
    if (
      conditional &&
      etag &&
      normaliseEtag(etag) === normaliseEtag(conditional)
    ) {
      return new Response(null, { status: 304, headers: hit.headers });
    }
    return hit;
  }

  const found = await storage.read(objectKey, {
    ifNoneMatch: conditional ?? undefined,
  });
  if (!found) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": found.object.contentType ?? imageContentType(objectKey),
    "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
    etag: found.object.etag,
  });

  if (!found.body) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(found.object.size));
  const response = new Response(found.body, { headers });
  cache.put(cacheKey, response.clone());

  return response;
}
