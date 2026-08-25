import type { RateLimits } from "@/services/ports/limits";

/**
 * Who the limiter is counting.
 *
 * `CF-Connecting-IP` rather than `X-Forwarded-For`: Cloudflare sets the former
 * itself on the way in and overwrites whatever the client claimed, so it is the
 * one header here that cannot be chosen by the visitor being limited. A key a
 * caller can pick is not a limit.
 *
 * Everything with no such header shares one bucket. That is not a Cloudflare
 * request — a health check on the loopback, `next dev`, a test — and lumping
 * them together is safe precisely because none of them is the public internet.
 */
export function visitorKey(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

/** What a route answers a visitor who has asked for too much. */
export function tooManyRequests(): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: {
      "Retry-After": "60",
    },
  });
}

/**
 * The gate in front of a route's bucket access: null to go ahead, or the
 * response to send instead.
 *
 * Deliberately not a boolean. `if (!allowed) return tooManyRequests()` is one
 * inverted condition away from a route that reads the answer and carries on
 * regardless, and this shape gives the caller nothing it can ignore — the only
 * thing to do with a response is return it.
 *
 * Call it as late as the route can: after the key has been checked, after the
 * response cache has been asked. A request that was never going to touch R2 —
 * a 404 from a malformed key, a cover served from the cache, a malformed body —
 * should not spend a visitor's allowance, or a shelf of covers would exhaust it
 * on the one page view that the cache made nearly free.
 */
export async function enforceR2RateLimit(
  request: Request,
  limits: RateLimits,
): Promise<Response | null> {
  const allowed = await limits.allowsR2(visitorKey(request));
  return allowed ? null : tooManyRequests();
}

/**
 * The second gate, for routes that hand over a whole file.
 *
 * Always after {@link enforceR2RateLimit} and never on its own: a download is
 * an R2 read too, and it should count as one before it is weighed as the
 * expensive thing it also is.
 */
export async function enforceDownloadRateLimit(
  request: Request,
  limits: RateLimits,
): Promise<Response | null> {
  const allowed = await limits.allowsDownload(visitorKey(request));
  return allowed ? null : tooManyRequests();
}
