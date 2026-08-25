import { normaliseEtag, parseBookKey } from "@bookshelf/core";
import { serviceUnavailable } from "@/lib/http";
import { imageContentType, isImage } from "@/lib/media";
import { getServices } from "@/services/container";
import { optional, reading } from "@/services/errors";

/**
 * A day, rather than `immutable`. Covers only change when one is re-uploaded to
 * correct it, and that correction should become visible without waiting a year
 * — the ETag below makes the revalidation a 304 rather than a re-download.
 */
const MAX_AGE_SECONDS = 86400;

/**
 * Serves a cover image out of the private bucket. The key comes from the book's
 * metadata — books without a cover get an inline placeholder from the page
 * instead of a request here.
 */
export async function GET(
  request: Request,
  routeContext: RouteContext<"/cover/[...key]">,
) {
  try {
    return await serve(request, routeContext);
  } catch (error) {
    // A cover that cannot be fetched leaves a gap in the shelf, which the page
    // already copes with — but it should not be cached as though it were a
    // book with no cover at all.
    return serviceUnavailable(error);
  }
}

async function serve(
  request: Request,
  routeContext: RouteContext<"/cover/[...key]">,
) {
  const { key } = await routeContext.params;
  const objectKey = key.join("/");

  // A cover is a file inside a book's folder and an image. The extension check
  // was already here and is the narrower of the two for this route; the shape
  // check is what keeps every byte route agreeing about which keys a request
  // may name, rather than each being safe for its own separate reason.
  if (!parseBookKey(objectKey) || !isImage(objectKey)) {
    return new Response("Not found", { status: 404 });
  }

  const { storage, cache } = await getServices();

  // Keyed by URL rather than the Request: under OpenNext this handler receives
  // a NextRequest wrapper, which the Cache API cannot use as a key.
  const cacheKey = request.url;
  const conditional = request.headers.get("if-none-match");

  const hit = await optional(() => cache.match(cacheKey));
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

  const found = await reading("a cover", () =>
    storage.read(objectKey, {
      ifNoneMatch: conditional ?? undefined,
    }),
  );
  if (!found) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    "content-type": found.object.contentType ?? imageContentType(objectKey),
    "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
    etag: found.object.etag,
    // An image served as something a browser sniffs its way into rendering
    // differently is the one way a cover could be more than a cover.
    "x-content-type-options": "nosniff",
  });

  if (!found.body) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(found.object.size));
  const response = new Response(found.body, { headers });
  void optional(async () => cache.put(cacheKey, response.clone()));

  return response;
}
