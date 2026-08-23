import { readFile } from "node:fs/promises";
import path from "node:path";
import { bytesSource, pdfDate, readPdfMetadata } from "@bookshelf/core";
import {
  findIsbn,
  isJunkTitle,
  type ReadBook,
  splitAuthors,
  splitSubjects,
  unique,
  xmpValues,
} from "./metadata.js";

/**
 * A timestamp cut back to its date, which is all a publication date claims.
 * Accepts null because `pdfDate` answers that for a date it could not parse.
 */
function day(value: string | null | undefined): string | undefined {
  return value ? value.slice(0, 10) : undefined;
}

/**
 * Reads what a PDF says about itself.
 *
 * A PDF records metadata in two places and agrees with itself only sometimes.
 * XMP is the newer of the two, is Dublin Core, and can hold a list where the
 * older form holds a string — three authors as three authors rather than as one
 * field with semicolons in it. So XMP is read first and the information
 * dictionary fills the gaps, field by field rather than wholesale, because a
 * document with a good XMP title and nothing else should still get its date
 * from the older half.
 *
 * The result is shaped exactly like {@link ./epub.mjs}'s, so the caller does not
 * branch on format beyond choosing which of the two to call. There is no cover:
 * a PDF's first page is its cover, and rendering it is a job for a rasteriser
 * rather than a parser.
 */
export async function readPdf(file: string): Promise<ReadBook> {
  const document = await readPdfMetadata(bytesSource(await readFile(file)));
  if (!document) throw new Error("not a valid PDF");

  const { info, xmp, pages, encrypted } = document;
  const from = (property: string): string[] =>
    xmp ? xmpValues(xmp, property) : [];

  const fileName = path.basename(file, path.extname(file));
  const tools = [info.Producer, info.Creator, ...from("xmp:CreatorTool")];

  // Each source is tested in turn rather than only the one that wins, because
  // the two disagree about which of them holds the good one often enough to
  // matter: a form whose XMP title is `stellenbeschreibung_2018.pdf` has its
  // real title sitting in the older dictionary, and taking XMP's word for it
  // would throw that away in favour of a file name.
  const title = [...from("dc:title"), info.Title]
    .filter(Boolean)
    .find((candidate) => !isJunkTitle(candidate, { fileName, tools }));

  // XMP gives authors as a list. The information dictionary gives one string
  // holding all of them, which has to be taken apart.
  const authors = from("dc:creator");
  const [description] = from("dc:description");
  const [publisher] = from("dc:publisher");
  const [language] = from("dc:language");

  // A PDF has three dates and none of them is the publication date. XMP's
  // `dc:date` is the closest thing to one and is kept as recorded; the other
  // two say when the *file* was written, which for a scan or a re-export is not
  // when the book came out. Those are cut back to the day, because a second's
  // precision about the wrong event is not worth publishing — and because it
  // then reads like an EPUB's `dc:date`, which is what the shelf expects.
  const published =
    from("dc:date")[0] ??
    day(from("xmp:CreateDate")[0]) ??
    day(info.CreationDate ? pdfDate(info.CreationDate) : undefined);

  const identifiers = [...from("dc:identifier"), ...from("prism:isbn")];
  const subjects = unique([
    ...from("dc:subject"),
    ...(info.Keywords ? splitSubjects(info.Keywords) : []),
  ]);

  return {
    metadata: {
      // Left unset when every candidate was rejected, so the caller applies the
      // same fall-back it uses for a PDF that recorded nothing at all.
      title,
      authors:
        authors.length > 0
          ? authors
          : info.Author
            ? splitAuthors(info.Author)
            : [],
      publisher,
      published,
      language,
      // Acrobat labels the information dictionary's `/Subject` "Subject", but
      // it is the description field — XMP maps it to `dc:description`, and the
      // keywords are what correspond to subjects.
      description: description ?? info.Subject,
      identifier: identifiers[0],
      isbn: findIsbn([...identifiers, ...subjects]),
      subjects,
      pages: pages ?? undefined,
    },
    cover: null,
    /**
     * True when the document is encrypted and so had nothing readable to give.
     * The caller says so rather than reporting a book that recorded nothing.
     */
    encrypted,
  };
}
