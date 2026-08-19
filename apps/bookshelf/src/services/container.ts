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
 * The library on a filesystem, for running the app on a machine that has one —
 * your own, or a VPS. There is no Workers cache here, and none is needed: the
 * catalog memo still spares the repeated reads, and the files are local.
 */
async function filesystemServices(): Promise<Services> {
  const directory =
    process.env.BOOKSHELF_DIRECTORY ?? process.env.BOOKSHELF_DIRECTORY_DEFAULT;

  if (!directory) {
    throw new Error(
      "The filesystem provider needs a directory. Set `storage.directory` in " +
        "bookshelf.config.json and rebuild, or pass BOOKSHELF_DIRECTORY at " +
        "startup.",
    );
  }

  const { createStorage } = await import("@bookshelf/provider-fs/node");
  return createServices(createStorage({ directory }), new NoopCache());
}

/** Said once per process, not once per request. */
let warnedAboutProxy = false;

/** The library in R2, read through the Worker binding. */
async function cloudflareServices(): Promise<Services> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { createStorage } = await import("@bookshelf/provider-r2/worker");

  // Reaching here without a Worker around it almost always means the app was
  // started somewhere with no bindings — a plain Node server — while still
  // built for Cloudflare. The underlying error says nothing about that.
  const context = await getCloudflareContext({ async: true }).catch(
    (cause: unknown) => {
      throw new Error(
        "No Cloudflare Worker context. If this is running on your own machine " +
          "or a VPS, it wants the filesystem provider: set `storage.provider` " +
          'to "fs" in bookshelf.config.json and rebuild, or start it with ' +
          "BOOKSHELF_PROVIDER=fs.",
        { cause },
      );
    },
  );

  const { env, ctx } = context;
  if (!env.BOOKS) {
    throw new Error(
      "The Worker has no BOOKS binding. Add an r2_buckets entry to " +
        "wrangler.jsonc naming the bucket the sync tool publishes to.",
    );
  }

  const cache = await openWorkersCache();

  // No cache API means this is Node, not workerd, and getCloudflareContext has
  // quietly handed back a local development proxy. In production that is nearly
  // always a build that should have been made for the filesystem: it appears to
  // work, while serving whatever the local miniflare bucket happens to hold.
  if (!cache && process.env.NODE_ENV === "production" && !warnedAboutProxy) {
    warnedAboutProxy = true;
    console.warn(
      "bookshelf: reading R2 through a local development proxy rather than a " +
        "Worker binding — this process is Node, so the shelf is whatever the " +
        "local miniflare bucket holds, not what is in R2. To serve a library " +
        'from this machine, set `storage.provider` to "fs" in ' +
        "bookshelf.config.json and rebuild.",
    );
  }

  return createServices(
    createStorage(env.BOOKS),
    // Absent under `next dev`, which runs in Node rather than workerd.
    cache
      ? new WorkersCache(cache, (work) => ctx.waitUntil(work))
      : new NoopCache(),
  );
}

/**
 * The composition root: the one place that names a provider.
 *
 * The default is baked in at build time from bookshelf.config.json — see
 * next.config.ts — so the app and the sync tool read the same answer out of the
 * same file. An environment variable still wins, for a deployment that differs
 * from the machine it was built on.
 *
 * Each arm imports its provider dynamically because the two are not
 * interchangeable at run time: one needs a Worker binding, the other a
 * filesystem, and whichever the deployment lacks must never be loaded.
 */
export async function getServices(): Promise<Services> {
  if (override) return override;

  const provider =
    process.env.BOOKSHELF_PROVIDER ??
    process.env.BOOKSHELF_PROVIDER_DEFAULT ??
    "r2";

  return provider === "fs" ? filesystemServices() : cloudflareServices();
}
