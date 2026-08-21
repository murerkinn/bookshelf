#!/usr/bin/env node
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Fetches the demo library from Project Gutenberg.
 *
 * The demo instance serves public-domain books so that it can be public at
 * all, and this is the list it serves. Kept as ids rather than files: 25 MB of
 * EPUBs do not belong in a repository, and a list can be re-fetched.
 *
 * The `.epub.noimages` edition is deliberate. It still carries a cover — which
 * is what the shelf wants — while being around 500 KB against 25 MB for the
 * illustrated edition, for the same text.
 *
 * Metadata is whatever each book says about itself, which for Gutenberg means
 * `dc:date` is its release date rather than the year the book was written.
 * That is the same rule the sync tool applies to every other library, so it is
 * left alone rather than special-cased.
 */

/** Project Gutenberg ebook ids. The title beside each is a comment, not data. */
export const BOOKS = [
  11, // Alice's Adventures in Wonderland — Carroll
  16, // Peter Pan — Barrie
  33, // The Scarlet Letter — Hawthorne
  35, // The Time Machine — Wells
  41, // The Legend of Sleepy Hollow — Irving
  43, // Dr Jekyll and Mr Hyde — Stevenson
  46, // A Christmas Carol — Dickens
  55, // The Wonderful Wizard of Oz — Baum
  74, // The Adventures of Tom Sawyer — Twain
  76, // Adventures of Huckleberry Finn — Twain
  84, // Frankenstein — Shelley
  98, // A Tale of Two Cities — Dickens
  103, // Around the World in Eighty Days — Verne
  105, // Persuasion — Austen
  120, // Treasure Island — Stevenson
  132, // The Art of War — Sun Tzu
  141, // Mansfield Park — Austen
  158, // Emma — Austen
  161, // Sense and Sensibility — Austen
  164, // Twenty Thousand Leagues under the Sea — Verne
  174, // The Picture of Dorian Gray — Wilde
  205, // Walden — Thoreau
  215, // The Call of the Wild — London
  219, // Heart of Darkness — Conrad
  236, // The Jungle Book — Kipling
  244, // A Study in Scarlet — Doyle
  345, // Dracula — Stoker
  514, // Little Women — Alcott
  600, // Notes from the Underground — Dostoyevsky
  730, // Oliver Twist — Dickens
  768, // Wuthering Heights — Brontë
  1080, // A Modest Proposal — Swift
  1184, // The Count of Monte Cristo — Dumas
  1232, // The Prince — Machiavelli
  1257, // The Three Musketeers — Dumas
  1260, // Jane Eyre — Brontë
  1342, // Pride and Prejudice — Austen
  1400, // Great Expectations — Dickens
  1497, // The Republic — Plato
  1513, // Romeo and Juliet — Shakespeare
  1524, // Hamlet — Shakespeare
  1533, // Macbeth — Shakespeare
  1661, // The Adventures of Sherlock Holmes — Doyle
  1727, // The Odyssey — Homer
  1998, // Thus Spake Zarathustra — Nietzsche
  2148, // The Works of Edgar Allan Poe, Volume 2 — Poe
  2542, // A Doll's House — Ibsen
  2554, // Crime and Punishment — Dostoyevsky
  2600, // War and Peace — Tolstoy
  2680, // Meditations — Marcus Aurelius
  2701, // Moby Dick — Melville
  2814, // Dubliners — Joyce
  3207, // Leviathan — Hobbes
  4300, // Ulysses — Joyce
  5200, // Metamorphosis — Kafka
  6130, // The Iliad — Homer
];

const AGENT =
  "bookshelf-demo/0.1 (+https://github.com/murerkinn/bookshelf) one-off demo library";

/** Gutenberg redirects this to whichever cache path currently holds it. */
function url(id) {
  return `https://www.gutenberg.org/ebooks/${id}.epub.noimages`;
}

async function alreadyThere(file) {
  try {
    return (await stat(file)).size > 1024;
  } catch {
    return false;
  }
}

/** Enough of a ZIP to be an EPUB rather than an error page. */
function looksLikeEpub(bytes) {
  return bytes.length > 1024 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function fetchBook(id, directory) {
  const file = path.join(directory, `pg${id}.epub`);
  if (await alreadyThere(file)) return "skipped";

  const response = await fetch(url(id), { headers: { "user-agent": AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!looksLikeEpub(bytes)) throw new Error("not an EPUB");

  await writeFile(file, bytes);
  return "fetched";
}

async function main(argv) {
  const directory = path.resolve(
    argv.find((a) => !a.startsWith("--")) ?? "gutenberg",
  );
  await mkdir(directory, { recursive: true });

  const counts = { fetched: 0, skipped: 0, failed: 0 };

  // One at a time on purpose. This is somebody else's bandwidth, and the whole
  // list is a few minutes even so.
  for (const id of BOOKS) {
    try {
      counts[await fetchBook(id, directory)]++;
    } catch (error) {
      counts.failed++;
      console.error(`  ${id}: ${error.message}`);
    }
  }

  const present = (await readdir(directory)).filter((f) =>
    f.endsWith(".epub"),
  ).length;
  console.log(
    `${counts.fetched} fetched, ${counts.skipped} already there, ` +
      `${counts.failed} failed — ${present} books in ${directory}`,
  );
  if (counts.failed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith(path.basename(import.meta.url))) {
  await main(process.argv.slice(2));
}
