import type { CatalogService } from "@/services/catalog";
import { optional } from "@/services/errors";

/**
 * Where a byte route keeps its answer in the response cache, or null where it
 * should not use the cache at all.
 *
 * Not the request's URL. A book's keys are its title slug, so they outlive the
 * book: removing it deletes the objects and leaves the URLs, and a later book
 * with the same title takes them over. Sync cannot reach the cache to purge
 * them. So the key names the catalog's generation — the date sync stamps on
 * every publish — and a publish moves every byte route onto keys nothing has
 * been stored under yet. What a removed book left behind is never matched
 * again, and the next request for it goes to storage and finds nothing there.
 *
 * The generation costs no read on a warm isolate, where the catalog memo
 * answers, and at most the catalog read every page already makes on a cold
 * one — never one per hit. It changes once the memo and the cached catalog
 * have both expired, a minute or two after a publish, which is how long the
 * shelf itself takes to notice.
 *
 * The query string is left out: no byte route reads one, and keeping it would
 * let `?anything` pass the cache by, at the cost of a read and a new entry.
 *
 * Null when even a stale catalog cannot be had. A key without a generation is
 * exactly the key that serves a removed book, so the cache is skipped rather
 * than consulted under one; storage being unreachable then surfaces as the
 * outage it is.
 */
export async function responseCacheKey(
  request: Request,
  catalog: CatalogService,
): Promise<string | null> {
  const shelf = await optional(() => catalog.shelf());
  if (!shelf) return null;

  const url = new URL(request.url);
  url.search = "";
  url.hash = "";
  // A catalog with no date — nothing published yet, or one written before sync
  // stamped them — shares one generation, which the next publish replaces.
  url.searchParams.set("generation", shelf.generatedAt ?? "");
  return url.href;
}
