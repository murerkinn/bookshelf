import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesSource, readZipDirectory, readZipEntry } from "@bookshelf/core";
import { writeZip } from "@bookshelf/fixtures";

const decoder = new TextDecoder();

/** A source that records what was asked of it, to count reads and bytes. */
function countingSource(bytes) {
  const reads = [];
  return {
    reads,
    source: {
      async size() {
        return bytes.byteLength;
      },
      async read(offset, length) {
        if (offset < 0 || length <= 0 || offset >= bytes.byteLength)
          return null;
        const end = Math.min(offset + length, bytes.byteLength);
        reads.push({ offset, length: end - offset });
        return bytes.subarray(offset, end);
      },
    },
  };
}

async function entry(archive, name) {
  const source = bytesSource(archive);
  const directory = await readZipDirectory(source);
  const found = directory?.get(name);
  if (!found) return null;
  const bytes = await readZipEntry(source, found);
  return bytes ? decoder.decode(bytes) : null;
}

test("reads a stored entry", async () => {
  const archive = writeZip([
    { name: "mimetype", content: "application/epub+zip" },
    { name: "OEBPS/content.opf", content: "<package/>" },
  ]);

  const directory = await readZipDirectory(bytesSource(archive));
  assert.deepEqual([...directory.keys()], ["mimetype", "OEBPS/content.opf"]);
  assert.equal(await entry(archive, "mimetype"), "application/epub+zip");
  assert.equal(await entry(archive, "OEBPS/content.opf"), "<package/>");
});

test("reads a deflated entry", async () => {
  // Compressible, so the stored and deflated lengths genuinely differ and the
  // reader cannot pass the test by ignoring the method.
  const chapter = "<p>the same sentence over and over</p>".repeat(50);
  const archive = writeZip([
    { name: "ch1.xhtml", content: chapter, deflate: true },
  ]);

  assert.equal(await entry(archive, "ch1.xhtml"), chapter);
});

test("parses past an extra field the directory does not describe", async () => {
  // A local header carries an extra field whose length only it records, so the
  // reader has to find the data by reading that header back.
  const archive = writeZip([{ name: "ch1.xhtml", content: "body", extra: 64 }]);
  assert.equal(await entry(archive, "ch1.xhtml"), "body");

  // Larger than the allowance the reader speculates with, which sends it back
  // for a second read rather than letting it truncate the entry.
  const padded = writeZip([
    { name: "ch1.xhtml", content: "body", extra: 4096 },
  ]);
  assert.equal(await entry(padded, "ch1.xhtml"), "body");
});

test("falls back to the directory when the header cannot state a size", async () => {
  // A streamed archive writes zeroes in the local header and puts the real
  // sizes in a descriptor after the data. Believing the header there would read
  // an entry of length zero.
  const archive = writeZip([
    { name: "ch1.xhtml", content: "streamed body", dataDescriptor: true },
    {
      name: "ch2.xhtml",
      content: "and another",
      dataDescriptor: true,
      deflate: true,
    },
  ]);

  assert.equal(await entry(archive, "ch1.xhtml"), "streamed body");
  assert.equal(await entry(archive, "ch2.xhtml"), "and another");
});

test("finds the end record behind a trailing comment", async () => {
  const archive = writeZip([{ name: "a.txt", content: "found me" }], {
    comment: "a comment long enough to move the end record".repeat(20),
  });

  assert.equal(await entry(archive, "a.txt"), "found me");
});

test("refuses a Zip64 archive rather than misreading it", async () => {
  const archive = writeZip([{ name: "a.txt", content: "x" }], { zip64: true });

  // Null, not a partial or wrong directory: the saturated fields mean the real
  // offsets are in a record this reader does not implement.
  assert.equal(await readZipDirectory(bytesSource(archive)), null);
});

test("is not a ZIP at all", async () => {
  assert.equal(await readZipDirectory(bytesSource(new Uint8Array(0))), null);
  assert.equal(
    await readZipDirectory(bytesSource(new TextEncoder().encode("%PDF-1.7"))),
    null,
  );
  // Long enough to be scanned, with no end record anywhere in it.
  assert.equal(
    await readZipDirectory(bytesSource(new Uint8Array(5000).fill(0x41))),
    null,
  );
});

test("an entry the directory does not list is simply absent", async () => {
  const archive = writeZip([{ name: "a.txt", content: "x" }]);
  const directory = await readZipDirectory(bytesSource(archive));

  assert.equal(directory.get("nope.txt"), undefined);
});

test("reads an entry in one ranged read", async () => {
  // The claim docs/reader.md makes, and the reason a cold open of a book costs
  // 73 KB rather than 1,755 KB. The local header sits in front of the data at
  // an offset the directory does not record, so the naive implementation reads
  // the header, then the data — two round trips per chapter, out to R2 and
  // back. This pins the single read.
  const archive = writeZip([
    { name: "mimetype", content: "application/epub+zip" },
    { name: "OEBPS/content.opf", content: "<package/>".repeat(10) },
    { name: "OEBPS/ch1.xhtml", content: "<p>a chapter</p>".repeat(100) },
  ]);

  const { source, reads } = countingSource(archive);
  const directory = await readZipDirectory(source);
  const directoryReads = reads.length;

  reads.length = 0;
  const bytes = await readZipEntry(source, directory.get("OEBPS/ch1.xhtml"));

  assert.equal(decoder.decode(bytes), "<p>a chapter</p>".repeat(100));
  assert.equal(reads.length, 1, "one entry should cost one ranged read");
  // And the directory itself is two: the tail holding the end record, then the
  // directory it points at.
  assert.equal(directoryReads, 2);
});

test("refuses an entry that is not where the directory says", async () => {
  // What a stale directory looks like: the app memoises one per book, and
  // republishing replaces the object underneath it at the same key. Reading
  // whatever happens to be at the old offset would serve one book's bytes as
  // another's, so a header that does not match is refused and the caller is
  // left to read the directory again.
  const archive = writeZip([
    { name: "first.xhtml", content: "the first chapter" },
    { name: "second.xhtml", content: "the second chapter" },
  ]);
  const source = bytesSource(archive);
  const directory = await readZipDirectory(source);

  const moved = { ...directory.get("second.xhtml"), localOffset: 9999 };
  assert.equal(await readZipEntry(source, moved), null);

  // An offset that lands on some other entry's header is caught by the name
  // length, which is what distinguishes one header from another cheaply.
  const confused = {
    ...directory.get("second.xhtml"),
    localOffset: directory.get("first.xhtml").localOffset,
  };
  assert.equal(await readZipEntry(source, confused), null);
});

test("an entry name is matched by length, not by re-encoding it", async () => {
  // Names are stored in whatever encoding the archive was written with, so
  // decoding and re-encoding one is not guaranteed to round-trip. A reader that
  // compared bytes would reject a perfectly good entry.
  const archive = writeZip([
    { name: "OEBPS/Kapitel-über-Bücher.xhtml", content: "unicode body" },
  ]);

  assert.equal(
    await entry(archive, "OEBPS/Kapitel-über-Bücher.xhtml"),
    "unicode body",
  );
});

test("an empty entry is empty, not missing", async () => {
  const archive = writeZip([
    { name: "empty.txt", content: "" },
    { name: "after.txt", content: "still readable" },
  ]);

  assert.equal(await entry(archive, "empty.txt"), "");
  assert.equal(await entry(archive, "after.txt"), "still readable");
});
