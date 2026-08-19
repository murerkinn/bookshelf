import type { Storage } from "@bookshelf/core";
import {
  openWorkersCache,
  WorkersCache,
} from "@/services/adapters/workers-cache";
import { CatalogService } from "@/services/catalog";
import { BookContentService } from "@/services/content";
import { NoopCache, type ResponseCache } from "@/services/ports/cache";

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
 * The composition root: the one place that names a provider.
 *
 * The provider is imported for the runtime the app is deployed to — R2 read
 * through a Worker binding — and everything above this line sees only the
 * contract, so porting means another root like this one rather than changes
 * to the app.
 */
export async function getServices(): Promise<Services> {
  if (override) return override;

  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { createStorage } = await import("@bookshelf/provider-r2/worker");
  const { env, ctx } = await getCloudflareContext({ async: true });

  const cache = await openWorkersCache();
  return createServices(
    createStorage(env.BOOKS),
    // Absent under `next dev`, which runs in Node rather than workerd.
    cache
      ? new WorkersCache(cache, (work) => ctx.waitUntil(work))
      : new NoopCache(),
  );
}
