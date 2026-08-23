#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { writeBooks } from "@bookshelf/fixtures";

/**
 * Writes the demo shelf into a directory of books.
 *
 * The books themselves come from @bookshelf/fixtures, which is also where the
 * tests get theirs — one generator, so the shelf in a screenshot is built the
 * same way as the shelf in a test. This file is only the command around it.
 */

async function isEmpty(directory) {
  try {
    return (await readdir(directory)).length === 0;
  } catch {
    return true;
  }
}

async function main(argv) {
  const force = argv.includes("--force");
  const target = argv.find((arg) => !arg.startsWith("--")) ?? "books";
  const directory = path.resolve(target);

  if (!force && !(await isEmpty(directory))) {
    console.error(
      `${directory} is not empty.\n\n` +
        "Refusing to add demo books to a directory that already holds some — " +
        "they would be published alongside yours and be tedious to tell " +
        "apart. Pass a different directory, or --force if you meant it.",
    );
    process.exit(1);
  }

  const written = await writeBooks(directory);
  console.log(`Wrote ${written.length} books to ${directory}`);
  console.log("\nPublish and serve them with:\n");
  console.log("  npm run sync -- --create");
  console.log("  npm run build && npm start -w @bookshelf/app\n");
}

await main(process.argv.slice(2));
