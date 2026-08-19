import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "@bookshelf/core";
import type { R2Config } from "./manifest.js";

type WranglerConfig = {
  r2_buckets?: { bucket_name?: string; jurisdiction?: string }[];
};

async function readIfPresent(file: string): Promise<WranglerConfig | null> {
  try {
    return parseJsonc(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }
}

/** The first R2 binding a Worker declares. */
async function readWorkerBucket(workerDir: string) {
  for (const name of ["wrangler.jsonc", "wrangler.json"]) {
    const file = path.join(workerDir, name);
    const config = await readIfPresent(file);
    const bucket = config?.r2_buckets?.[0];
    if (bucket?.bucket_name) {
      return {
        file,
        bucket: bucket.bucket_name,
        jurisdiction: bucket.jurisdiction,
      };
    }
  }
  return null;
}

/** Relative where that is shorter to read, absolute where it escapes upwards. */
function describePath(root: string, file: string): string {
  const relative = path.relative(root, file);
  return relative.startsWith("..") ? file : relative;
}

export type ResolvedR2Config = Required<Pick<R2Config, "bucket">> &
  Omit<R2Config, "bucket"> & {
    cwd: string;
    warnings: string[];
  };

/**
 * Works out which bucket to publish to.
 *
 * Config is the source of truth, but a Cloudflare user has already declared the
 * bucket once in `wrangler.jsonc`, so leaving `bucket` out reads it from there
 * instead. Declaring it in both and disagreeing is the case worth catching: the
 * sync would upload to one bucket while the Worker reads the other, and the
 * shelf would simply look empty.
 */
export async function resolveConfig(
  config: R2Config & { projectRoot?: string },
): Promise<ResolvedR2Config> {
  const root = config.projectRoot ?? process.cwd();
  const cwd = path.resolve(root, config.worker ?? ".");
  const declared = await readWorkerBucket(cwd);
  const warnings: string[] = [];

  if (config.bucket && declared && declared.bucket !== config.bucket) {
    warnings.push(
      `config publishes to "${config.bucket}", but ` +
        `${describePath(root, declared.file)} binds the Worker to ` +
        `"${declared.bucket}". The app will not see what this uploads.`,
    );
  }

  const bucket = config.bucket ?? declared?.bucket;
  if (!bucket) {
    throw new Error(
      "no R2 bucket configured. Name one in bookshelf.config.json:\n\n" +
        '  { "storage": { "provider": "r2", "bucket": "books" } }\n\n' +
        "or point `worker` at a directory whose wrangler.jsonc declares one.",
    );
  }

  return {
    ...config,
    bucket,
    jurisdiction: config.jurisdiction ?? declared?.jurisdiction,
    cwd,
    warnings,
  };
}
