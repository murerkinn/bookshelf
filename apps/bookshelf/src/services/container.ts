import { readOnlyStorage, type Storage } from "@bookshelf/core";
import {
  openWorkersCache,
  WorkersCache,
} from "@/services/adapters/workers-cache";
import { workersRateLimits } from "@/services/adapters/workers-rate-limit";
import { CatalogService } from "@/services/catalog";
import { BookContentService } from "@/services/content";
import { NoopCache, type ResponseCache } from "@/services/ports/cache";
import { NoLimits, type RateLimits } from "@/services/ports/limits";
import { ProfileService } from "@/services/profiles";
import { ProgressService } from "@/services/progress";

export type Services = {
  storage: Storage;
  cache: ResponseCache;
  /** What the routes ask before they reach for the bucket. */
  limits: RateLimits;
  catalog: CatalogService;
  content: BookContentService;
  profiles: ProfileService;
  progress: ProgressService;
};

/**
 * Wires the services to a set of adapters. This is the whole composition, and
 * it knows nothing about any provider — give it storage backed by S3 or a
 * filesystem and the app works unchanged. Storage that cannot be written to
 * still composes; profiles and reading positions degrade rather than fail.
 *
 * Limits default to none for the same reason: a runtime that cannot count
 * requests per visitor is one that does not need to.
 */
export function createServices(
  storage: Storage,
  cache: ResponseCache,
  limits: RateLimits = new NoLimits(),
): Services {
  return {
    storage,
    cache,
    limits,
    catalog: new CatalogService(storage, cache),
    content: new BookContentService(storage, cache),
    profiles: new ProfileService(storage),
    progress: new ProgressService(storage),
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
 * Whether this deployment refuses to change anything.
 *
 * A property of the instance rather than of the library, so it comes from the
 * environment and not from bookshelf.config.json: the same build serves a
 * public demo that must not be edited and a private shelf that must be. The
 * only thing it does is take the write path off storage, which every service
 * already knows how to cope with — profiles stop offering to change anything
 * and reading positions go back to living in the browser.
 */
function refusesEdits(): boolean {
  const value = (process.env.BOOKSHELF_READ_ONLY ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

function compose(
  storage: Storage,
  cache: ResponseCache,
  limits?: RateLimits,
): Services {
  return createServices(
    refusesEdits() ? readOnlyStorage(storage) : storage,
    cache,
    limits,
  );
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

  // Left for the runtime to resolve rather than bundled. This provider reads a
  // directory named at startup, so its `open` and `createReadStream` calls take
  // a path the bundler cannot know — and Turbopack answers that by tracing the
  // whole project into the server output, `public/` and all, warning eight
  // times on the way past. The directory is not a build input and never was;
  // saying so is what the comment does. Nothing here changes for the Worker,
  // which resolves the other provider and never reaches this branch.
  const { createStorage } = await import(
    /* turbopackIgnore: true */ "@bookshelf/provider-fs/node"
  );
  return compose(createStorage({ directory }), new NoopCache());
}

/** Both said once per process, not once per request. */
let warnedAboutProxy = false;
let warnedAboutLimits = false;

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

  // The bucket is only reachable through this Worker and the Worker is public,
  // so what stops one visitor from spending the library's whole R2 allowance is
  // the pair of bindings named here. Absent in local development, where there
  // is no public anybody and the bindings are not bound.
  const limits = workersRateLimits(env);
  if (!limits && process.env.NODE_ENV === "production" && !warnedAboutLimits) {
    warnedAboutLimits = true;
    console.warn(
      "bookshelf: no rate limiting bindings, so every request may reach R2 " +
        "as often as it likes. Add the ratelimits entries for R2_RATE_LIMITER " +
        "and DOWNLOAD_RATE_LIMITER to wrangler.jsonc.",
    );
  }

  return compose(
    createStorage(env.BOOKS),
    // Absent under `next dev`, which runs in Node rather than workerd.
    cache
      ? new WorkersCache(cache, (work) => ctx.waitUntil(work))
      : new NoopCache(),
    limits ?? undefined,
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
