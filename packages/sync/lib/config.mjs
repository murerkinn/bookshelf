import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** Where the Worker lives, and so where wrangler has to be run from. */
export const WORKER_DIR = path.join(ROOT, "apps", "bookshelf");

/**
 * Fixed by convention rather than passed in: drop books into one, the tree to
 * upload is built in the other. Both are gitignored.
 */
export const INPUT_DIR = path.join(ROOT, "books");
export const OUTPUT_DIR = path.join(ROOT, "library");

export const CATALOG_FILE = "catalog.json";
export const METADATA_FILE = "metadata.json";
export const CATALOG_VERSION = 1;

/** 4x the 60px slot the shelf renders covers into, so they stay sharp on retina. */
export const DEFAULT_COVER_HEIGHT = 240;

export const BOOK_EXTENSIONS = new Set([".epub", ".pdf"]);

/**
 * Strips comments from JSONC without mangling any that appear inside strings.
 */
function stripComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  return out;
}

/**
 * Reads the bucket to publish to out of wrangler.jsonc, so the script and the
 * deployed Worker can never disagree about where books live.
 */
export async function readBucketConfig() {
  const file = path.join(WORKER_DIR, "wrangler.jsonc");
  const config = JSON.parse(stripComments(await readFile(file, "utf8")));
  const bucket = config.r2_buckets?.[0];

  if (!bucket?.bucket_name) {
    throw new Error(`no r2_buckets entry found in ${file}`);
  }

  return {
    bucket: bucket.bucket_name,
    jurisdiction: bucket.jurisdiction,
  };
}
