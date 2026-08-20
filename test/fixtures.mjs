#!/usr/bin/env node
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { epub } from "./lib/epub.mjs";

/**
 * A shelf of books that can be generated anywhere, for the demo and for tests.
 *
 * The titles, authors and years are real works in the public domain, so a
 * shelf of them looks like a shelf rather than like test data — which matters
 * when the point is a screenshot. The prose inside is not theirs.
 *
 * `Meditations` deliberately has no cover, so the shelf's placeholder tile is
 * exercised too.
 */
export const BOOKS = [
  {
    file: "pride-and-prejudice",
    title: "Pride and Prejudice",
    authors: ["Jane Austen"],
    publisher: "T. Egerton",
    published: "1813",
    subjects: ["Fiction", "Romance"],
    description: "Elizabeth Bennet, Mr Darcy, and five daughters to marry off.",
    colour: [122, 138, 168],
  },
  {
    file: "frankenstein",
    title: "Frankenstein; or, The Modern Prometheus",
    authors: ["Mary Wollstonecraft Shelley"],
    publisher: "Lackington, Hughes, Harding, Mavor & Jones",
    published: "1818",
    subjects: ["Fiction", "Horror", "Science fiction"],
    description: "A student of unhallowed arts and the thing he assembles.",
    colour: [86, 104, 96],
  },
  {
    file: "moby-dick",
    title: "Moby-Dick; or, The Whale",
    authors: ["Herman Melville"],
    publisher: "Harper & Brothers",
    published: "1851",
    subjects: ["Fiction", "Adventure", "Sea stories"],
    description: "Call me Ishmael. A voyage, a captain, and a white whale.",
    colour: [64, 92, 126],
    chapters: 5,
  },
  {
    file: "the-time-machine",
    title: "The Time Machine",
    authors: ["H. G. Wells"],
    publisher: "William Heinemann",
    published: "1895",
    subjects: ["Fiction", "Science fiction"],
    description:
      "An inventor travels forward, and does not like what he finds.",
    colour: [138, 116, 90],
  },
  {
    file: "dracula",
    title: "Dracula",
    authors: ["Bram Stoker"],
    publisher: "Archibald Constable and Company",
    published: "1897",
    subjects: ["Fiction", "Horror", "Epistolary fiction"],
    description: "Letters, diaries and telegrams, assembled into a warning.",
    colour: [110, 74, 82],
  },
  {
    file: "alices-adventures-in-wonderland",
    title: "Alice's Adventures in Wonderland",
    authors: ["Lewis Carroll"],
    publisher: "Macmillan",
    published: "1865",
    subjects: ["Fiction", "Fantasy", "Children's literature"],
    description: "Down a rabbit hole, and the logic that applies below it.",
    colour: [150, 128, 96],
  },
  {
    file: "the-adventures-of-sherlock-holmes",
    title: "The Adventures of Sherlock Holmes",
    authors: ["Arthur Conan Doyle"],
    publisher: "George Newnes",
    published: "1892",
    subjects: ["Fiction", "Mystery", "Short stories"],
    description: "Twelve cases, narrated by the doctor who followed them.",
    colour: [96, 106, 118],
    chapters: 4,
  },
  {
    file: "meditations",
    title: "Meditations",
    authors: ["Marcus Aurelius"],
    published: "180",
    subjects: ["Philosophy", "Stoicism"],
    description: "Notes an emperor wrote to himself, and not for us.",
    // No cover: the shelf renders its initials on a tinted tile instead, and
    // that path deserves to be exercised too.
    cover: false,
  },
];

/** Writes the shelf into `directory` as EPUB files. Returns their paths. */
export async function writeBooks(directory, books = BOOKS) {
  await mkdir(directory, { recursive: true });

  const written = [];
  for (const book of books) {
    const file = path.join(directory, `${book.file}.epub`);
    await writeFile(file, epub(book));
    written.push(file);
  }
  return written;
}

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

// Only when run directly, so the exports stay importable from tests.
if (
  process.argv[1] &&
  import.meta.url.endsWith(path.basename(process.argv[1]))
) {
  await main(process.argv.slice(2));
}
