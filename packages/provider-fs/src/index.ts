/**
 * The provider's own description, free of any runtime-specific import.
 *
 * Both working halves are in one entry point here, because both run in Node —
 * entry points are named for the runtime they need, not for the face they
 * implement:
 *
 *   @bookshelf/provider-fs/node   Storage and StorageAdmin
 */
export type { FsConfig } from "./manifest.js";
export { manifest } from "./manifest.js";
