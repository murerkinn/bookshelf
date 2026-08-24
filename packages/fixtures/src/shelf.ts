import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type BookSpec, epub } from "./epub.js";
import { bookPdf } from "./pdf.js";

/**
 * A shelf of books that can be generated anywhere, for the demo and for tests.
 *
 * The titles, authors and years are real works in the public domain, so a
 * shelf of them looks like a shelf rather than like test data — which matters
 * when the point is a screenshot. The prose inside is not theirs.
 *
 * `Meditations` deliberately has no cover, so the shelf's placeholder tile is
 * exercised too, and `On the Origin of Species` is a PDF, so that the shelf a
 * screenshot is taken of has both of the formats this app can read and the
 * other reader is one click away rather than reachable only by URL.
 */
export type DemoBook = BookSpec & {
  /** The file name to write it as, without an extension. */
  file: string;
  /** EPUB unless said otherwise. */
  format?: "epub" | "pdf";
};

export const BOOKS: DemoBook[] = [
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
    // Named the way a PDF that was downloaded from somewhere is named, rather
    // than after its own title — which is what makes the sync tool take the
    // title from the document's metadata. A file named after the title is
    // rejected as an echo of the file name, by design: see `isJunkTitle`.
    file: "darwin-origin-1859",
    title: "On the Origin of Species",
    authors: ["Charles Darwin"],
    publisher: "John Murray",
    published: "1859",
    subjects: ["Science", "Biology", "Evolution"],
    description:
      "Variation under domestication, and the struggle for existence.",
    format: "pdf",
    chapters: 6,
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

/** Writes the shelf into `directory`. Returns the paths written. */
export async function writeBooks(
  directory: string,
  books: readonly DemoBook[] = BOOKS,
): Promise<string[]> {
  await mkdir(directory, { recursive: true });

  const written: string[] = [];
  for (const book of books) {
    const pdf = book.format === "pdf";
    const file = path.join(directory, `${book.file}.${pdf ? "pdf" : "epub"}`);
    await writeFile(file, pdf ? bookPdf(book) : epub(book));
    written.push(file);
  }
  return written;
}
