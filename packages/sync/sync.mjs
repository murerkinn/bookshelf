#!/usr/bin/env node
/**
 * Builds the library and publishes it to the bucket.
 *
 *   npm run sync                build ./library from ./books, then upload it
 *   npm run sync -- --force    clear the bucket first
 *   npm run sync -- --dry-run  build the tree, upload nothing
 *
 * Input and output directories are fixed by convention — books go in ./books,
 * the tree to upload is built in ./library — and both are gitignored.
 *
 * Each book becomes a folder holding every format of it, its cover and the
 * metadata read out of the book itself, with a catalog at the root:
 *
 *   library/
 *     essential-math-for-data-science/
 *       metadata.json
 *       cover.webp
 *       essential-math-for-data-science.epub
 *     catalog.json
 *
 * Where it publishes to is a target (see lib/targets), so another provider is a
 * new file there rather than a change here.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { syncLibrary } from "./lib/bucket.mjs";
import { buildLibrary } from "./lib/build.mjs";
import {
  DEFAULT_COVER_HEIGHT,
  INPUT_DIR,
  OUTPUT_DIR,
  ROOT,
} from "./lib/config.mjs";
import { findThumbnailer } from "./lib/images.mjs";
import { createTarget, TARGET_NAMES } from "./lib/targets/index.mjs";

const USAGE = `usage: npm run sync -- [options]

  --force            clear the bucket before uploading
  --dry-run          build the library but publish nothing
  --local            publish to the local (miniflare) bucket, for testing
  --target NAME      where to publish (default wrangler-r2; available: ${TARGET_NAMES.join(", ")})
  --size N           cover thumbnail height in pixels (default ${DEFAULT_COVER_HEIGHT})
  --full             keep full-size covers instead of thumbnailing them

Books are read from ./books and the upload tree is built in ./library.`;

function parseArgs(argv) {
  const options = {
    force: false,
    dryRun: false,
    local: false,
    target: "wrangler-r2",
    height: DEFAULT_COVER_HEIGHT,
    full: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--target") options.target = argv[++i];
    else if (arg === "--size") options.height = Number(argv[++i]);
    else if (arg === "--full") options.full = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.height) || options.height <= 0) {
    throw new Error("--size must be a positive integer");
  }

  return options;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const log = (message) => console.log(message);

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }

  if (!(await exists(INPUT_DIR))) {
    const legacy = path.join(ROOT, "epub");
    console.error(
      `No ${path.relative(ROOT, INPUT_DIR)}/ directory.` +
        ((await exists(legacy))
          ? "\n\nThere is an epub/ directory — this script now reads from books/.\n  mv epub books"
          : `\n\nCreate it and put your books in it:\n  mkdir ${path.relative(ROOT, INPUT_DIR)}`),
    );
    process.exit(1);
  }

  // Resolved before any work, so an unknown target fails immediately rather
  // than after building the whole library.
  const target = options.dryRun
    ? null
    : await createTarget(options.target, { local: options.local });

  const thumb = options.full ? null : await findThumbnailer();
  if (!options.full && !thumb) {
    console.error(
      "No image scaler found. Install one (`brew install webp` for cwebp), or\n" +
        "pass --full to keep full-size covers — but note those run about a\n" +
        "hundred times larger than the shelf can display.",
    );
    process.exit(1);
  }

  log(
    `Building ${path.relative(ROOT, OUTPUT_DIR)}/ from ${path.relative(ROOT, INPUT_DIR)}/…`,
  );
  const { books, failed } = await buildLibrary(
    INPUT_DIR,
    OUTPUT_DIR,
    options,
    thumb,
    log,
  );

  const withCover = books.filter((book) => book.cover).length;
  const withAuthors = books.filter((book) => book.authors.length).length;
  log(
    `\n${books.length} books built, ${failed} failed. ` +
      `${withCover} with covers, ${withAuthors} with authors.`,
  );

  if (options.dryRun) {
    log(
      `\nDry run: ${path.relative(ROOT, OUTPUT_DIR)}/ is ready, nothing published.`,
    );
    return;
  }

  log("");

  const result = await syncLibrary(target, OUTPUT_DIR, {
    force: options.force,
    log,
  });

  log(
    `\nPublished ${result.uploaded} objects` +
      (result.removed ? `, removed ${result.removed}` : "") +
      (result.failed ? `, ${result.failed} failed` : "") +
      ".",
  );

  if (options.force && !result.exact) {
    log(
      "\nNote: this target cannot list the bucket, so --force cleared only what\n" +
        "the previously published catalog recorded. Objects put there by other\n" +
        "means are untouched.",
    );
  }

  if (result.failed) process.exit(1);
}

try {
  await main();
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}
