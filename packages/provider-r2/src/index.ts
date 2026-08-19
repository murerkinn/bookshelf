/**
 * The provider's own description. Kept free of any runtime-specific import, so
 * that reading it — to list providers, or to generate their documentation —
 * costs nothing and works anywhere.
 *
 * The two working halves are separate entry points:
 *
 *   @bookshelf/provider-r2/worker   Storage, over an R2 binding
 *   @bookshelf/provider-r2/node     StorageAdmin, over the wrangler CLI
 */

export type { R2Config } from "./manifest.js";
export { manifest } from "./manifest.js";
