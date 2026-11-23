import { normaliseEtag, parseBookKey } from "@bookshelf/core";
import { serviceUnavailable } from "@/lib/http";
import { coverContentType, isCover } from "@/lib/media";
import { enforceR2RateLimit } from "@/lib/rate-limit";
import { responseCacheKey } from "@/lib/response-cache";
import { getServices } from "@/services/container";
import { optional, reading } from "@/services/errors";

/**
 * A day, rather than `immutable`. Covers only change when one is re-uploaded to
 * correct it or its book is removed or replaced, and that should become visible
 * without waiting a year — the ETag below makes the revalidation a 304 rather
 * than a re-download. Only browsers, and any proxy in front of the Node server,
 * hold a cover this long regardless: the response cache here moves on with the
 * catalog (see `responseCacheKey`).
 */
const MAX_AGE_SECONDS = 86400;

/**
 * A cover is only ever drawn by an `<img>`, which ignores a policy on what it
 * fetches. This is for the one other way to reach it: opened on its own, as a
 * page of this origin. Then it may run nothing and load nothing. The inline
 * style is the browser's own, which some lay out a lone image with.
 *
 * Sent by the route rather than left to `next.config`, which holds this path
 * out of the page policy: Next sends a header from the config in place of the
 * route's own, and that policy allows inline script.
 */
const CONTENT_SECURITY_POLICY =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

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
  if (!parseBookKey(objectKey) || !isCover(objectKey)) {
    return new Response("Not found", { status: 404 });
  }

  const { catalog, storage, cache, limits } = await getServices();

  // Keyed by a URL rather than the Request: under OpenNext this handler
  // receives a NextRequest wrapper, which the Cache API cannot use as a key.
  // And not this request's URL, so that a removed or replaced cover is not
  // served from the cache after a publish.
  const cacheKey = await responseCacheKey(request, catalog);
  const conditional = request.headers.get("if-none-match");

  const hit = cacheKey ? await optional(() => cache.match(cacheKey)) : null;
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

  // After the cache, because a cover served from it never reaches the bucket.
  // A shelf of twenty books asks this route twenty times for one page view, and
  // charging a visitor for the nineteen the cache answered would spend their
  // whole allowance on a page that touched R2 once.
  const limited = await enforceR2RateLimit(request, limits);
  if (limited) return limited;

  const found = await reading("a cover", () =>
    storage.read(objectKey, {
      ifNoneMatch: conditional ?? undefined,
    }),
  );
  if (!found) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers({
    // From the key, never the type the provider stored. Sync stores the same
    // answer, but the bucket is not necessarily only ever written by sync, and
    // whoever wrote this object could have called it `text/html`.
    "content-type": coverContentType(objectKey),
    "cache-control": `public, max-age=${MAX_AGE_SECONDS}`,
    etag: found.object.etag,
    // An image served as something a browser sniffs its way into rendering
    // differently is the one way a cover could be more than a cover.
    "x-content-type-options": "nosniff",
    "content-security-policy": CONTENT_SECURITY_POLICY,
  });

  if (!found.body) {
    return new Response(null, { status: 304, headers });
  }

  headers.set("content-length", String(found.object.size));
  const response = new Response(found.body, { headers });
  if (cacheKey) {
    void optional(async () => cache.put(cacheKey, response.clone()));
  }

  return response;
}
