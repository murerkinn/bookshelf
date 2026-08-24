import type { Book } from "@bookshelf/core";

/**
 * The axes a catalog can be browsed along: author, subject, series.
 *
 * All three are groupings of the array the catalog already holds in the
 * isolate, so browsing costs no reads — which is what lets the feed offer them
 * without the generated index roadmap #9 will eventually need.
 */

export type Group = { name: string; books: Book[] };

/**
 * Groups by a name each book may carry several of, or none.
 *
 * Names are matched exactly, after trimming. Two spellings of one author are
 * two authors here, which is a fact about the metadata rather than a decision:
 * folding them is the same work as folding diacritics in search, and belongs
 * with it in #9 rather than being guessed at twice.
 */
function group(books: Book[], namesOf: (book: Book) => string[]): Group[] {
  const held = new Map<string, Book[]>();

  for (const book of books) {
    for (const raw of namesOf(book)) {
      const name = raw.trim();
      // A book with no author is not filed under an invented one. It is still
      // under every book, which is where someone looking for it will find it.
      if (!name) continue;

      const existing = held.get(name);
      if (existing) existing.push(book);
      else held.set(name, [book]);
    }
  }

  return [...held]
    .map(([name, grouped]) => ({ name, books: grouped }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function byAuthor(books: Book[]): Group[] {
  return group(books, (book) => book.authors);
}

export function bySubject(books: Book[]): Group[] {
  return group(books, (book) => book.subjects ?? []);
}

/**
 * By series, and in reading order within one — the only grouping where the
 * catalog's alphabetical order is the wrong answer. A volume with no index
 * sorts last rather than first, because an unnumbered extra is more often a
 * companion than a prequel.
 */
export function bySeries(books: Book[]): Group[] {
  return group(books, (book) => (book.series ? [book.series] : [])).map(
    ({ name, books: grouped }) => ({
      name,
      books: [...grouped].sort(
        (a, b) =>
          (a.seriesIndex ?? Number.POSITIVE_INFINITY) -
            (b.seriesIndex ?? Number.POSITIVE_INFINITY) ||
          a.title.localeCompare(b.title),
      ),
    }),
  );
}

export function named(groups: Group[], name: string): Group | undefined {
  return groups.find((group) => group.name === name);
}
