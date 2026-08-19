#!/usr/bin/env node
/**
 * Builds the library and publishes it to the bucket.
 *
 *   bookshelf-sync              build the library, then upload it
 *   bookshelf-sync --force      clear the bucket first
 *   bookshelf-sync --dry-run    build the tree, upload nothing
 *
 * Where books are read from, where the tree is built, and where it publishes to
 * all come from bookshelf.config.json, found by walking up from the working
 * directory. Without one, the conventional layout applies: books in ./books,
 * the upload tree in ./library.
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
 * Where it publishes to is a provider package, resolved by importing it, so
 * another destination is a package rather than a change here.
 */

import { access } from "node:fs/promises";
import path from "node:path";
import { syncLibrary } from "./lib/bucket.mjs";
import { buildLibrary } from "./lib/build.mjs";
import { CONFIG_FILES, DEFAULTS, loadConfig } from "./lib/config.mjs";
import { findThumbnailer } from "./lib/images.mjs";
import { BUILT_IN_IDS, createAdmin } from "./lib/providers.mjs";

const USAGE = `usage: npm run sync -- [options]

  --force            clear the bucket before uploading
  --dry-run          build the library but publish nothing
  --local            publish to the local (miniflare) bucket, for testing
  --create           provision the destination first, if the provider can
  --provider NAME    which provider to publish through (built in: ${BUILT_IN_IDS.join(", ")};
                     anything else is imported as a package)
  --size N           cover thumbnail height in pixels
  --full             keep full-size covers instead of thumbnailing them

Directories and provider settings are read from ${CONFIG_FILES[0]}; the flags
above override it for one run.`;

function parseArgs(argv) {
  const options = {
    force: false,
    dryRun: false,
    local: false,
    full: false,
    create: false,
    /** Left unset so the configured value shows through. */
    provider: null,
    height: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--local") options.local = true;
    else if (arg === "--create") options.create = true;
    else if (arg === "--provider") options.provider = argv[++i];
    else if (arg === "--size") options.height = Number(argv[++i]);
    else if (arg === "--full") options.full = true;
    else throw new Error(`unknown option: ${arg}`);
  }

  if (
    options.height !== null &&
    (!Number.isInteger(options.height) || options.height <= 0)
  ) {
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

  const config = await loadConfig();
  const here = (file) => path.relative(config.root, file) || ".";

  if (!(await exists(config.inputDir))) {
    console.error(
      `No ${here(config.inputDir)}/ directory.\n\n` +
        `Create it and put your books in it:\n  mkdir ${here(config.inputDir)}` +
        (config.configFile
          ? ""
          : `\n\nOr point somewhere else from a ${CONFIG_FILES[0]}:\n` +
            `  { "input": "${DEFAULTS.input}", "output": "${DEFAULTS.output}" }`),
    );
    process.exit(1);
  }

  // Resolved before any work, so an unknown provider or a missing setting fails
  // immediately rather than after building the whole library.
  const admin = options.dryRun
    ? null
    : await createAdmin(options.provider ?? config.storage.provider, {
        ...config.storage,
        local: options.local,
      });

  for (const warning of admin?.warnings ?? []) {
    console.warn(`warning: ${warning}\n`);
  }

  if (options.create) {
    if (!admin) {
      throw new Error("--create has nothing to do during a --dry-run");
    }
    if (!admin.create) {
      throw new Error(
        `${admin.name} cannot provision its destination; create it yourself first`,
      );
    }
    log(
      (await admin.create())
        ? `Created the destination for ${admin.name}.`
        : `Destination for ${admin.name} needed no creating.`,
    );
  }

  const thumb = options.full ? null : await findThumbnailer();
  if (!options.full && !thumb) {
    console.error(
      "No image scaler found. Install one (`brew install webp` for cwebp), or\n" +
        "pass --full to keep full-size covers — but note those run about a\n" +
        "hundred times larger than the shelf can display.",
    );
    process.exit(1);
  }

  log(`Building ${here(config.outputDir)}/ from ${here(config.inputDir)}/…`);
  const { books, failed } = await buildLibrary(
    config.inputDir,
    config.outputDir,
    { height: options.height ?? config.coverHeight },
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
    log(`\nDry run: ${here(config.outputDir)}/ is ready, nothing published.`);
    return;
  }

  log("");

  const result = await syncLibrary(admin, config.outputDir, {
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
      "\nNote: this provider cannot enumerate its destination, so --force cleared\n" +
        "only what the previously published catalog recorded. Objects put there\n" +
        "by other means are untouched.",
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
