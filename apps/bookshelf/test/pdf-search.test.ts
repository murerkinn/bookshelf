import assert from "node:assert/strict";
import { test } from "node:test";
import { findOnPage, fold } from "../src/app/read/[...key]/pdf-document.ts";

/**
 * Searching inside a PDF, which is two pure functions with one hard constraint
 * between them: a match is found in text that has been folded and shown from
 * text that has not. Everything worth testing here is that correspondence.
 *
 * The module is a client component, but only its `import type` reaches pdf.js —
 * the library itself is loaded inside a function — so it loads in Node.
 */

const search = (text: string, query: string) => {
  const folded = fold(text);
  return findOnPage(1, text, folded, fold(query).folded);
};

test("case and accents are folded, so Bronte finds Brontë", () => {
  const hits = search("Emily Brontë wrote it.", "bronte");

  assert.equal(hits.length, 1);
  // Shown as it was written, not as it was matched against.
  assert.equal(hits[0].match, "Brontë");
});

test("an offset in the folded text points back at the original", () => {
  // Every accent in front of the match shifts the two copies further apart, so
  // an excerpt cut with a folded offset would drift a character per accent.
  const text = "Café, naïve, Brontë: the word wanted is résumé, here.";
  const hits = search(text, "resume");

  assert.equal(hits.length, 1);
  assert.equal(hits[0].match, "résumé");
  assert.match(hits[0].after, /^, here\.$/);
});

test("a run of whitespace is one space, so a phrase crosses a line break", () => {
  const hits = search("a range\nrequest and very little else", "range request");

  assert.equal(hits.length, 1);
  // The break is carried into the match and shown as a space.
  assert.equal(hits[0].match, "range request");
});

test("matches do not overlap", () => {
  // Resuming one character on would find four; resuming past the match finds
  // the two a reader would count.
  const hits = search("aaaa", "aa");
  assert.equal(hits.length, 2);
});

test("an excerpt is cut at a word, not at a character", () => {
  // Long enough on both sides that the window closes before the text does,
  // which is the only case in which anything is cut at all.
  const filler =
    "Storage keeps the bytes, the catalogue keeps the order, the reader keeps " +
    "the place, and the next chapter says much the same at a different offset. ";
  const text = `${filler}Between the shelf and the page there is a range request and very little else. ${filler}`;

  const [hit] = search(text, "range request");
  assert.ok(hit, "a hit");

  // Both sides say they were cut, and neither cut lands inside a word.
  assert.match(hit.before, /^…\S/);
  assert.match(hit.after, /\S…$/);

  const opening = hit.before.slice(1).split(" ")[0];
  assert.ok(
    text.includes(` ${opening} `),
    `${opening} is a whole word of the page`,
  );

  const closing = hit.after.slice(0, -1).trim().split(" ").at(-1) ?? "";
  assert.ok(
    text.includes(` ${closing} `) || text.includes(` ${closing}`),
    `${closing} is a whole word of the page`,
  );
});

test("an excerpt at the start of a page is not marked as cut", () => {
  const [hit] = search("A range request opens the book.", "range request");

  assert.ok(hit, "a hit");
  assert.equal(hit.before, "A ");
  assert.equal(hit.after, " opens the book.");
});

test("nothing matches nothing, and an empty query matches nothing at all", () => {
  assert.deepEqual(search("the whole page", "absent"), []);
  assert.deepEqual(search("the whole page", ""), []);
  assert.deepEqual(search("", "anything"), []);
});

test("folding maps every folded character back to one it came from", () => {
  const text = "Æon  —  café";
  const { folded, map } = fold(text);

  assert.equal(folded.length, map.length);
  for (const [index, at] of map.entries()) {
    assert.ok(at >= 0 && at < text.length, `${folded[index]} came from ${at}`);
  }
  // Non-decreasing: an offset later in the folded copy is never earlier in the
  // original, which is what makes a slice between two of them meaningful.
  for (let i = 1; i < map.length; i++) {
    assert.ok(map[i] >= map[i - 1]);
  }
});
