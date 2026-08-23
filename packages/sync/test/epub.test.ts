import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeZip } from "@bookshelf/fixtures";
import { readEpub } from "@bookshelf/sync/epub";

/**
 * An EPUB built around one package document.
 *
 * Deliberately lower-level than @bookshelf/fixtures's `epub()`, which builds plausible
 * books for the demo shelf. What is under test here is how the reader copes
 * with the ways a real package document differs from a tidy one — a cover
 * declared three different ways, a path that climbs out of its own directory,
 * an ampersand that arrives encoded — so the fixture has to be the awkward
 * part rather than a whole believable book.
 */
async function book({
  metadata = "",
  manifest = "",
  opfPath = "OEBPS/content.opf",
  entries = [],
}) {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${metadata}
  </metadata>
  <manifest>
${manifest}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;

  const archive = writeZip([
    { name: "mimetype", content: "application/epub+zip" },
    {
      name: "META-INF/container.xml",
      content: `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles><rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    { name: opfPath, content: opf },
    ...entries,
  ]);

  const directory = await mkdtemp(path.join(tmpdir(), "bookshelf-epub-"));
  const file = path.join(directory, "book.epub");
  await writeFile(file, archive);
  return file;
}

/** A one-pixel-ish PNG, standing in for a cover image. */
const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/**
 * Compares image bytes without minding the exact array type. A stored entry
 * comes back as a subarray of whatever the file was read into, which for
 * `readFile` is a Buffer — the same bytes, a different prototype.
 */
function sameBytes(actual, expected) {
  assert.deepEqual(Uint8Array.from(actual), expected);
}

test("reads the Dublin Core a package document carries", async () => {
  const { metadata } = await readEpub(
    await book({
      metadata: `    <dc:title>Essential Math for Data Science</dc:title>
    <dc:creator>Thomas Nield</dc:creator>
    <dc:publisher>O'Reilly Media, Inc.</dc:publisher>
    <dc:date>2022-05-26</dc:date>
    <dc:language>en</dc:language>
    <dc:identifier id="id">9781098102937</dc:identifier>
    <dc:description>Master the math needed to excel.</dc:description>`,
    }),
  );

  assert.equal(metadata.title, "Essential Math for Data Science");
  assert.deepEqual(metadata.authors, ["Thomas Nield"]);
  assert.equal(metadata.publisher, "O'Reilly Media, Inc.");
  assert.equal(metadata.published, "2022-05-26");
  assert.equal(metadata.language, "en");
  assert.equal(metadata.identifier, "9781098102937");
  assert.equal(metadata.isbn, "9781098102937");
  assert.equal(metadata.description, "Master the math needed to excel.");
});

test("decodes the entities an XML title arrives with", async () => {
  // Left encoded, this would be stored as `ATT&amp;CK`, escaped a second time
  // on render, and dragged into the book's slug as "att-amp-ck".
  const { metadata } = await readEpub(
    await book({
      metadata:
        "    <dc:title>ATT&amp;CK &#8212; Tactics &#x2014; Techniques</dc:title>",
    }),
  );

  assert.equal(metadata.title, "ATT&CK — Tactics — Techniques");
});

test("finds a title in a default namespace as well as a prefixed one", async () => {
  // Most books write `dc:title`; a few declare Dublin Core as the default
  // namespace and write `title` bare.
  const { metadata } = await readEpub(
    await book({ metadata: "    <title>No Prefix Here</title>" }),
  );

  assert.equal(metadata.title, "No Prefix Here");
});

test("keeps every creator, and collapses the whitespace around them", async () => {
  const { metadata } = await readEpub(
    await book({
      metadata: `    <dc:creator>Leonard Richardson</dc:creator>
    <dc:creator opf:role="aut">
       Sam
       Ruby
    </dc:creator>`,
    }),
  );

  assert.deepEqual(metadata.authors, ["Leonard Richardson", "Sam Ruby"]);
});

test("takes subjects one per element or several in one", async () => {
  const { metadata } = await readEpub(
    await book({
      metadata: `    <dc:title>Tagged</dc:title>
    <dc:subject>England -- Fiction</dc:subject>
    <dc:subject>Love stories</dc:subject>
    <dc:subject>Fiction, Romance; Classics</dc:subject>
    <dc:subject>Love stories</dc:subject>`,
    }),
  );

  // Split where a book crammed a list into one element, and deduplicated —
  // "Love stories" was recorded twice.
  assert.deepEqual(metadata.subjects, [
    "England -- Fiction",
    "Love stories",
    "Fiction",
    "Romance",
    "Classics",
  ]);
});

test("only reports an ISBN when the identifier really is one", async () => {
  const isbn = await readEpub(
    await book({
      metadata:
        '    <dc:identifier id="id">urn:isbn:9781449358068</dc:identifier>',
    }),
  );
  assert.equal(isbn.metadata.isbn, "9781449358068");

  // Project Gutenberg records a URL, which contains digits and is not an ISBN.
  const url = await readEpub(
    await book({
      metadata:
        '    <dc:identifier id="id">http://www.gutenberg.org/1342</dc:identifier>',
    }),
  );
  assert.equal(url.metadata.identifier, "http://www.gutenberg.org/1342");
  assert.equal(url.metadata.isbn, undefined);

  const uuid = await readEpub(
    await book({
      metadata:
        '    <dc:identifier id="id">urn:uuid:0d5f4a70-1111-4000-8000-000000000000</dc:identifier>',
    }),
  );
  assert.equal(uuid.metadata.isbn, undefined);
});

test("reads a series from either convention", async () => {
  // What Calibre has written into every book it ever exported.
  const calibre = await readEpub(
    await book({
      metadata: `    <dc:title>Mort</dc:title>
    <meta name="calibre:series" content="Discworld"/>
    <meta name="calibre:series_index" content="4.0"/>`,
    }),
  );
  assert.equal(calibre.metadata.series, "Discworld");
  assert.equal(calibre.metadata.seriesIndex, 4);

  // What EPUB 3 specifies instead.
  const epub3 = await readEpub(
    await book({
      metadata: `    <dc:title>Mort</dc:title>
    <meta property="belongs-to-collection" id="c01">Discworld</meta>
    <meta refines="#c01" property="group-position">4</meta>`,
    }),
  );
  assert.equal(epub3.metadata.series, "Discworld");
  assert.equal(epub3.metadata.seriesIndex, 4);

  // A book in no series says nothing rather than saying nothing loudly.
  const neither = await readEpub(
    await book({ metadata: "    <dc:title>Standalone</dc:title>" }),
  );
  assert.equal(neither.metadata.series, undefined);
  assert.equal(neither.metadata.seriesIndex, undefined);
});

test("finds the cover the EPUB 3 way", async () => {
  const { cover } = await readEpub(
    await book({
      manifest:
        '    <item id="c" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
      entries: [{ name: "OEBPS/images/cover.jpg", content: IMAGE }],
    }),
  );

  sameBytes(cover.body, IMAGE);
  assert.equal(cover.extension, ".jpg");
});

test("finds the cover the EPUB 2 way", async () => {
  // No `properties`, so the only thing tying the meta to the item is its id.
  const { cover } = await readEpub(
    await book({
      metadata: '    <meta name="cover" content="the-cover"/>',
      manifest: `    <item id="not-it" href="images/logo.png" media-type="image/png"/>
    <item id="the-cover" href="images/front.png" media-type="image/png"/>`,
      entries: [
        { name: "OEBPS/images/logo.png", content: new Uint8Array([9, 9]) },
        { name: "OEBPS/images/front.png", content: IMAGE },
      ],
    }),
  );

  sameBytes(cover.body, IMAGE);
  assert.equal(cover.extension, ".png");
});

test("falls back to an image that merely looks like a cover", async () => {
  const { cover } = await readEpub(
    await book({
      manifest: `    <item id="a" href="images/plate1.jpeg" media-type="image/jpeg"/>
    <item id="b" href="images/cover-front.jpeg" media-type="image/jpeg"/>`,
      entries: [
        { name: "OEBPS/images/plate1.jpeg", content: new Uint8Array([7]) },
        { name: "OEBPS/images/cover-front.jpeg", content: IMAGE },
      ],
    }),
  );

  sameBytes(cover.body, IMAGE);
  // The media type decides the extension, not the file name — `.jpeg` here
  // becomes the `.jpg` the rest of the pipeline expects.
  assert.equal(cover.extension, ".jpg");
});

test("resolves a cover path that climbs out of the package's directory", async () => {
  const { cover } = await readEpub(
    await book({
      opfPath: "OEBPS/package/content.opf",
      manifest:
        '    <item id="c" href="../images/cover.png" media-type="image/png" properties="cover-image"/>',
      entries: [{ name: "OEBPS/images/cover.png", content: IMAGE }],
    }),
  );

  sameBytes(cover.body, IMAGE);
});

test("resolves a cover path that is percent-encoded", async () => {
  const { cover } = await readEpub(
    await book({
      manifest:
        '    <item id="c" href="images/front%20cover.png" media-type="image/png" properties="cover-image"/>',
      entries: [{ name: "OEBPS/images/front cover.png", content: IMAGE }],
    }),
  );

  sameBytes(cover.body, IMAGE);
});

test("a book with no cover is not a failure", async () => {
  const { metadata, cover } = await readEpub(
    await book({ metadata: "    <dc:title>Meditations</dc:title>" }),
  );

  assert.equal(metadata.title, "Meditations");
  assert.equal(cover, null);
});

test("a cover the manifest promises but the archive lacks is no cover", async () => {
  const { cover } = await readEpub(
    await book({
      manifest:
        '    <item id="c" href="images/missing.png" media-type="image/png" properties="cover-image"/>',
    }),
  );

  assert.equal(cover, null);
});

test("says what is wrong with something that is not a readable book", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bookshelf-epub-"));

  const notZip = path.join(directory, "a.epub");
  await writeFile(notZip, "this is not an archive");
  await assert.rejects(readEpub(notZip), /not a valid ZIP archive/);

  // A ZIP, but not an EPUB: no container to name the package document.
  const noContainer = path.join(directory, "b.epub");
  await writeFile(noContainer, writeZip([{ name: "a.txt", content: "x" }]));
  await assert.rejects(readEpub(noContainer), /no META-INF\/container.xml/);

  // A container pointing at a package document that is not in the archive.
  const noOpf = path.join(directory, "c.epub");
  await writeFile(
    noOpf,
    writeZip([
      {
        name: "META-INF/container.xml",
        content:
          '<container><rootfiles><rootfile full-path="gone.opf"/></rootfiles></container>',
      },
    ]),
  );
  await assert.rejects(readEpub(noOpf), /missing package document: gone.opf/);
});
