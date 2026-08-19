import type { ProviderManifest } from "@bookshelf/core";

/**
 * Cloudflare R2, reached two different ways: the app reads through a Worker
 * binding, the CLI writes through the wrangler executable. Same bucket, two
 * transports, because a Worker cannot spawn a process and Node has no binding.
 */
export const manifest: ProviderManifest = {
  id: "r2",
  title: "Cloudflare R2",
  summary:
    "Reads through a Worker binding, publishes through the wrangler CLI. " +
    "Needs no credentials beyond a wrangler login.",
  capabilities: {
    create: true,
    list: false,
    removeAll: false,
  },
  options: [
    {
      key: "bucket",
      required: true,
      summary: "Name of the R2 bucket to publish into.",
      example: "books",
    },
    {
      key: "jurisdiction",
      required: false,
      summary: "R2 jurisdiction the bucket was created in.",
      example: "eu",
    },
    {
      key: "worker",
      required: false,
      summary:
        "Directory holding the Worker's wrangler.jsonc. wrangler runs there, " +
        "so it picks up the right account and settings.",
      example: "apps/bookshelf",
    },
  ],
  notes: [
    "wrangler exposes only get, put and delete for objects — there is no way " +
      "to enumerate a bucket. This provider therefore has no list, and --force " +
      "clears what the last published catalog recorded rather than everything.",
  ],
};

/** What this provider accepts under `storage` in bookshelf.config.json. */
export type R2Config = {
  bucket: string;
  jurisdiction?: string;
  /** Where wrangler runs. Defaults to the process's working directory. */
  worker?: string;
  /** Publish to the local miniflare bucket instead of the real one. */
  local?: boolean;
};
