import { isUnavailable } from "@/services/errors";

/**
 * What a route answers when the library could not be reached.
 *
 * A 503 rather than a 404, because the two mean opposite things to whatever is
 * asking. A reader told a chapter is missing gives up on it; a reader told to
 * come back shortly does. It is the same distinction the services draw between
 * absent and unreachable, carried out to the wire.
 *
 * Rethrows anything that is not an unreachable library, so a bug still reaches
 * the error boundary rather than being dressed up as an outage.
 */
export function serviceUnavailable(error: unknown): Response {
  if (!isUnavailable(error)) throw error;

  return new Response("The library could not be reached. Try again shortly.", {
    status: 503,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Long enough that a reader turning pages does not hammer a failing
      // bucket, short enough to be worth waiting out.
      "retry-after": "5",
      // Never cached: the next request may well succeed, and a cached 503
      // outlives the outage that caused it.
      "cache-control": "no-store",
    },
  });
}
