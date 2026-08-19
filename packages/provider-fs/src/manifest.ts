import type { ProviderManifest } from "@bookshelf/core";

/**
 * A directory on disk. The library is exactly the tree the sync tool builds,
 * copied into place, so it can be inspected, backed up and moved with ordinary
 * tools — which is much of the point of keeping a library as plain files.
 *
 * Unlike R2 over wrangler, everything optional in the contract is available
 * here: a directory can be created, walked, and emptied.
 */
export const manifest: ProviderManifest = {
  id: "fs",
  title: "Local filesystem",
  summary:
    "Holds the library in a directory. Needs no account and no network — for " +
    "a machine on your own network, or a VPS you run the app on.",
  capabilities: {
    create: true,
    list: true,
    removeAll: true,
  },
  options: [
    {
      key: "directory",
      required: true,
      summary:
        "Where the published library lives. Relative paths resolve against " +
        "the config file, not the working directory.",
      example: "library-data",
    },
  ],
  notes: [
    "The app must run somewhere with a filesystem — `next start` on a VPS or " +
      "on your own machine — rather than on Workers, which has none.",
    "Because a directory can be enumerated, --force clears the destination " +
      "exactly rather than falling back to the published catalog.",
  ],
};

/** What this provider accepts under `storage` in bookshelf.config.json. */
export type FsConfig = {
  directory: string;
};
