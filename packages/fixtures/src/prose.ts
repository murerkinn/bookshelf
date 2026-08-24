/**
 * The words the generated books are filled with.
 *
 * Shared by the EPUB and the PDF builders so that the same book generated as
 * either format reads the same way — which is what makes the two comparable
 * when a reader is being worked on, and what keeps a screenshot of one honest
 * about the other.
 */

export const PLACEHOLDER = `This book is generated. Its title, author and publication
year belong to a real work in the public domain; the words on this page do not
— they are filler, so that a shelf and a reader can be exercised without
shipping anyone's prose.`;

export const SENTENCES = [
  "The archive holds a catalogue, and the catalogue holds this page.",
  "A reader asks for one chapter at a time, and gets one chapter at a time.",
  "Between the shelf and the page there is a range request and very little else.",
  "Nothing here was written by anyone; it was assembled to take up room.",
  "A paragraph long enough to wrap is a paragraph worth having in a fixture.",
  "The position of this sentence can be saved, and later restored.",
  "Two columns, one column, or a single scroll: the words do not mind.",
  "Storage keeps the bytes, the catalogue keeps the order, the reader keeps the place.",
  "If this text is visible, an entry was found, decompressed and rendered.",
  "The next chapter says much the same, at a different offset.",
];

/**
 * Enough prose to fill a page, so that paginating and turning are exercised
 * rather than merely available. Deterministic: the same chapter of the same
 * book always reads the same way.
 */
export function filler(seed: number, paragraphs = 6): string[] {
  let state = seed * 2654435761 + 1;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };

  return Array.from({ length: paragraphs }, () => {
    const count = 4 + Math.floor(next() * 4);
    return Array.from(
      { length: count },
      () => SENTENCES[Math.floor(next() * SENTENCES.length)],
    ).join(" ");
  });
}
