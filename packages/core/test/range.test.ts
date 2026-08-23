import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampRange,
  contentRange,
  ifRangeMatches,
  normaliseEtag,
  parseByteRange,
  unsatisfiedRange,
} from "@bookshelf/core";

/** The parse, as `offset-last` for readability, or the kind when there is none. */
function parse(header, size = 1000) {
  const result = parseByteRange(header, size);
  if (result.kind !== "range") return result.kind;
  const { offset, length } = result.range;
  return `${offset}-${offset + length - 1}`;
}

test("reads the range forms a client actually sends", () => {
  // A closed range, which is what a PDF viewer walking a file sends.
  assert.equal(parse("bytes=0-499"), "0-499");
  assert.equal(parse("bytes=500-999"), "500-999");
  // One byte, which is how some clients probe for range support.
  assert.equal(parse("bytes=0-0"), "0-0");
  // Open-ended, which is what a resumed download sends.
  assert.equal(parse("bytes=200-"), "200-999");
  // The whole thing, asked for as a range. Still a range, and still a 206.
  assert.equal(parse("bytes=0-"), "0-999");
  // A suffix: the last N bytes, without needing to know the length.
  assert.equal(parse("bytes=-500"), "500-999");
});

test("clamps what the client could not have known", () => {
  // Asking past the end is not an error: the client is allowed not to know how
  // long the object is.
  assert.equal(parse("bytes=900-5000"), "900-999");
  // A suffix longer than the object is the whole object.
  assert.equal(parse("bytes=-5000"), "0-999");
  assert.equal(parse("bytes=0-999", 1000), "0-999");
});

test("only a range beyond the end is an error", () => {
  assert.equal(parse("bytes=1000-"), "unsatisfiable");
  assert.equal(parse("bytes=1000-2000"), "unsatisfiable");
  assert.equal(parse("bytes=5000-"), "unsatisfiable");
  // A zero-length suffix asks for nothing, which cannot be satisfied.
  assert.equal(parse("bytes=-0"), "unsatisfiable");
  // Nothing can be served from an empty object.
  assert.equal(parse("bytes=0-", 0), "unsatisfiable");
  assert.equal(parse("bytes=0-0", 0), "unsatisfiable");
});

test("anything it cannot make sense of is served whole", () => {
  // No header at all.
  assert.equal(parse(null), "whole");
  assert.equal(parse(undefined), "whole");
  assert.equal(parse(""), "whole");

  // A unit this server does not implement.
  assert.equal(parse("pages=1-2"), "whole");
  assert.equal(parse("items=0-9"), "whole");

  // Malformed, in the ways seen in the wild.
  assert.equal(parse("bytes=abc-def"), "whole");
  assert.equal(parse("bytes=-"), "whole");
  assert.equal(parse("bytes="), "whole");
  assert.equal(parse("bytes"), "whole");
  assert.equal(parse("bytes=1.5-2"), "whole");

  // Ends before it starts, which the specification calls invalid.
  assert.equal(parse("bytes=500-100"), "whole");

  // More than one range. Legal to decline, and declining beats building a
  // multipart body nothing here would ask for.
  assert.equal(parse("bytes=0-99,200-299"), "whole");
  assert.equal(parse("bytes=0-99, 200-"), "whole");

  // A number too large to be an exact integer would clamp to nonsense.
  assert.equal(parse("bytes=99999999999999999999-"), "whole");
});

test("is not fussy about spacing or case", () => {
  assert.equal(parse("  bytes=0-99  "), "0-99");
  assert.equal(parse("BYTES=0-99"), "0-99");
  assert.equal(parse("bytes = 0-99"), "0-99");
  assert.equal(parse("bytes=0-99,"), "0-99");
});

test("clampRange narrows to what an object can answer", () => {
  assert.deepEqual(clampRange({ offset: 0, length: 100 }, 1000), {
    offset: 0,
    length: 100,
  });
  // Longer than what is left.
  assert.deepEqual(clampRange({ offset: 900, length: 500 }, 1000), {
    offset: 900,
    length: 100,
  });

  // The cases a provider must refuse rather than serve as an empty 206: the
  // object shrank, or was replaced by an empty one, after its size was read.
  assert.equal(clampRange({ offset: 1000, length: 10 }, 1000), null);
  assert.equal(clampRange({ offset: 2000, length: 10 }, 1000), null);
  assert.equal(clampRange({ offset: 0, length: 10 }, 0), null);
  assert.equal(clampRange({ offset: 0, length: 0 }, 1000), null);
  assert.equal(clampRange({ offset: -1, length: 10 }, 1000), null);
});

test("describes what it served, and what it could not", () => {
  assert.equal(
    contentRange({ offset: 0, length: 500 }, 1000),
    "bytes 0-499/1000",
  );
  assert.equal(
    contentRange({ offset: 500, length: 500 }, 1000),
    "bytes 500-999/1000",
  );
  assert.equal(contentRange({ offset: 0, length: 1 }, 1), "bytes 0-0/1");
  // A 416 names only the length, which is the part the client got wrong.
  assert.equal(unsatisfiedRange(1000), "bytes */1000");
  assert.equal(unsatisfiedRange(0), "bytes */0");
});

test("normalises an entity tag to the part that identifies the version", () => {
  assert.equal(normaliseEtag('"abc123"'), "abc123");
  assert.equal(normaliseEtag('W/"abc123"'), "abc123");
  assert.equal(normaliseEtag('  "abc123"  '), "abc123");
  assert.equal(normaliseEtag("abc123"), "abc123");
});

test("If-Range guards a resumed download against a replaced book", () => {
  // No guard sent: the range stands.
  assert.equal(ifRangeMatches(null, '"abc"'), true);
  assert.equal(ifRangeMatches(undefined, '"abc"'), true);

  // The version the client holds part of is still the current one.
  assert.equal(ifRangeMatches('"abc"', '"abc"'), true);

  // Republished since. Continuing from an offset would splice two files, so
  // the range must be declined.
  assert.equal(ifRangeMatches('"abc"', '"def"'), false);

  // A weak validator does not promise the bytes are identical, so it may not
  // be used to resume; nor may a date, which this server does not offer.
  assert.equal(ifRangeMatches('W/"abc"', '"abc"'), false);
  assert.equal(ifRangeMatches("Wed, 21 Oct 2015 07:28:00 GMT", '"abc"'), false);
});
