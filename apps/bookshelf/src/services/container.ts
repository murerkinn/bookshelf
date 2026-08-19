import { R2Storage } from "@/services/adapters/r2-storage";
import {
  openWorkersCache,
  WorkersCache,
} from "@/services/adapters/workers-cache";
import { CatalogService } from "@/services/catalog";
import { BookContentService } from "@/services/content";
import { NoopCache, type ResponseCache } from "@/services/ports/cache";
import type { Storage } from "@/services/ports/storage";

export type Services = {
  storage: Storage;
  cache: ResponseCache;
  catalog: CatalogService;
  content: BookContentService;
};

/**
 * Wires the services to a set of adapters. This is the whole composition, and
 * it knows nothing about any provider — give it storage backed by S3 or a
 * filesystem and the app works unchanged.
 */
export function createServices(
  storage: Storage,
  cache: ResponseCache,
): Services {
  return {
    storage,
    cache,
    catalog: new CatalogService(storage, cache),
    content: new BookContentService(storage, cache),
  };
}

let override: Services | null = null;

/**
 * Replaces what {@link getServices} returns. Tests use this to supply fakes;
 * a different runtime would use it to install its own adapters at startup.
 * Passing null restores the default.
 */
export function setServices(services: Services | null): void {
  override = services;
}

/**
 * The Cloudflare composition root: the one place that knows this is running on
 * Workers. Route handlers and pages call this and see only the interfaces, so
 * porting to another platform means writing adapters and another root like
 * this one, not touching the app.
 */
export async function getServices(): Promise<Services> {
  if (override) return override;

  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env, ctx } = await getCloudflareContext({ async: true });

  const cache = await openWorkersCache();
  return createServices(
    new R2Storage(env.BOOKS),
    // Absent under `next dev`, which runs in Node rather than workerd.
    cache
      ? new WorkersCache(cache, (work) => ctx.waitUntil(work))
      : new NoopCache(),
  );
}
