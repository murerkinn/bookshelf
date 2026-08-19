import { readBucketConfig } from "../config.mjs";
import { createWranglerR2Target } from "./wrangler-r2.mjs";

/**
 * A place to publish a built library to.
 *
 * @typedef {object} SyncTarget
 * @property {string} name          shown to the user before anything is written
 * @property {(key: string) => Promise<Buffer|null>} read
 * @property {(key: string, file: string, contentType: string) => Promise<void>} put
 * @property {(key: string) => Promise<void>} remove
 * @property {number=} concurrency  safe parallel writes; defaults to 4
 * @property {(() => Promise<string[]>)=} list
 *   Optional. Providers that can enumerate a bucket implement it, and `--force`
 *   then clears everything. Providers that cannot — wrangler has no listing —
 *   leave it undefined, and the sync falls back to the published catalog.
 */

const TARGETS = {
  /** Cloudflare R2 via the wrangler CLI. Needs no credentials beyond a login. */
  "wrangler-r2": async ({ local }) => {
    const { bucket, jurisdiction } = await readBucketConfig();
    return createWranglerR2Target({ bucket, jurisdiction, local });
  },
};

export const TARGET_NAMES = Object.keys(TARGETS);

export async function createTarget(name, options) {
  const factory = TARGETS[name];
  if (!factory) {
    throw new Error(
      `unknown target "${name}" (available: ${TARGET_NAMES.join(", ")})`,
    );
  }
  return factory(options);
}
