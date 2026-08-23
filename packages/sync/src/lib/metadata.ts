/**
 * What a book says about itself, before the build gives it an id, a cover file
 * and a list of formats.
 *
 * The optional fields are optional because a book that does not record something
 * is the normal case rather than an error — see `docs/library-format.md`. Only
 * `authors` is always present, because every book has a list of them even when
 * it is empty.
 */
export type BookMetadata = {
  title?: string;
  authors: string[];
  publisher?: string;
  published?: string;
  language?: string;
  identifier?: string;
  isbn?: string;
  description?: string;
  subjects?: string[];
  series?: string;
  seriesIndex?: number;
  pages?: number;
};

/** A cover as the format carried it: bytes, and what to call the file. */
export type CoverImage = {
  body: Uint8Array;
  /** Including the dot, e.g. `.jpg`. */
  extension: string;
};

/**
 * What a format reader answers with. One shape for both, so the caller chooses
 * which reader to call and nothing else.
 */
export type ReadBook = {
  metadata: BookMetadata;
  /** Null where the format has no cover, or carries none. */
  cover: CoverImage | null;
  /** True where the document was readable but its metadata was not. */
  encrypted?: boolean;
};

/**
 * Reading metadata out of the two kinds of markup a book carries it in.
 *
 * An EPUB records it as Dublin Core in its package document; a PDF records it as
 * Dublin Core in an XMP packet, and again, less richly, in its own information
 * dictionary. The vocabulary is the same, the syntax is not, and neither is
 * trustworthy — so the extraction lives here rather than twice, and so does the
 * judgement about what is worth keeping.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Package metadata is XML, so a title containing an ampersand arrives as
 * `ATT&amp;CK`. Left encoded it would be stored that way, escaped a second time
 * on render, and dragged into the book's slug as "att-amp-ck".
 */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g,
    (match: string, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

/** Markup stripped, entities decoded, whitespace collapsed. */
function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/** A regular-expression-safe form of a tag or attribute name. */
function quote(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every value of an element, by local name, whatever namespace prefix it
 * carries. Most EPUBs write `<dc:title>`, a few use a default namespace, and
 * the prefix is not worth caring about either way.
 */
export function elementValues(xml: string, localName: string): string[] {
  const name = quote(localName);
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    "gi",
  );
  return [...xml.matchAll(pattern)]
    .map((match) => clean(match[1]))
    .filter(Boolean);
}

/**
 * Every value of an XMP property, by qualified name.
 *
 * XMP writes the same property three ways and real files use all of them: as an
 * element holding text, as an element wrapping an `rdf:Alt`, `rdf:Seq` or
 * `rdf:Bag` of `rdf:li` items, or — for single values — as an attribute on
 * `rdf:Description`. A reader that handles only the first finds no title in an
 * arXiv PDF and no publisher in any.
 *
 * The name is qualified rather than local because XMP prefixes are fixed by
 * convention, and `dc:date` should not be answered with `xmp:ModifyDate`.
 */
export function xmpValues(xmp: string, qualifiedName: string): string[] {
  const name = quote(qualifiedName);
  const values: string[] = [];

  const elements = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  for (const match of xmp.matchAll(elements)) {
    const inner = match[1];
    const items = [...inner.matchAll(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/gi)];
    if (items.length > 0) {
      // An `rdf:Alt` is a set of translations of one value, so only the first
      // is wanted; a `Seq` or `Bag` is a list, and all of it is.
      const alternative = /<rdf:Alt\b/i.test(inner);
      for (const item of alternative ? items.slice(0, 1) : items) {
        values.push(clean(item[1]));
      }
    } else {
      values.push(clean(inner));
    }
  }

  const attributes = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "gi");
  for (const match of xmp.matchAll(attributes)) {
    values.push(clean(match[1]));
  }

  return values.filter(Boolean);
}

/**
 * Splits an author string into authors.
 *
 * A PDF records every author in one field, and separates them however the
 * writing tool felt like. Semicolons and conjunctions are safe to split on; a
 * comma is not, because "Richardson, Leonard" is one person written backwards
 * and splitting it would invent a second.
 */
export function splitAuthors(value: string): string[] {
  return value
    .split(/\s*;\s*|\s+(?:&|and)\s+/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Extensions that give away a title that is really a file name. */
const DOCUMENT_EXTENSIONS =
  /\.(?:pdf|docx?|pages|odt|rtf|txt|tex|indd|idml|qxd|pptx?|xlsx?|epub|md)$/i;

/** Titles that carry no information, whatever the document is. */
const EMPTY_TITLES = new Set([
  "untitled",
  "untitled document",
  "untitled1",
  "document",
  "document1",
  "no title",
  "title",
  "unknown",
  "print",
  "slide 1",
  "chapter 1",
  "book",
]);

/** Comparable form of a name: case, punctuation and spacing all flattened. */
function flatten(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Whether a recorded title is worth having.
 *
 * PDF writers fill the field in with whatever is to hand, which is very often
 * the file name, the name of the program, or nothing dressed up as something.
 * A file name is no worse than the one the library would fall back to and no
 * better, so the point of rejecting it is not to improve on it — it is that a
 * title is used to slug the book and to decide whether metadata was found at
 * all, and neither should be built on `Microsoft Word - doc1.docx`.
 *
 * Deliberately conservative: it takes real evidence to reject a title, so
 * something like `coyotiv-brochure-v1.3-web` is kept. It is ugly, but it is
 * what the document says it is called, and guessing past that costs more than
 * it returns.
 */
export function isJunkTitle(
  title: string | undefined,
  {
    fileName,
    tools = [],
  }: { fileName?: string; tools?: (string | undefined)[] } = {},
): boolean {
  const trimmed = (title ?? "").trim();
  if (!trimmed) return true;
  if (EMPTY_TITLES.has(trimmed.toLowerCase())) return true;
  if (DOCUMENT_EXTENSIONS.test(trimmed)) return true;

  // "Microsoft Word - something", and its relatives, are the program's doing.
  if (/^microsoft\s+(?:word|powerpoint|excel|publisher)\b/i.test(trimmed)) {
    return true;
  }

  const flat = flatten(trimmed);
  if (!flat) return true;
  if (fileName && flat === flatten(fileName)) return true;
  // A title identical to the producing program is the program's name, not the
  // document's.
  if (tools.some((tool) => tool && flatten(tool) === flat)) return true;

  return false;
}

/** ISBN-13 check digit: alternating weights of 1 and 3, summing to a multiple of ten. */
function validIsbn13(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}

/** ISBN-10 check digit: descending weights, modulo eleven, with X for ten. */
function validIsbn10(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = digits[i] === "X" ? 10 : Number(digits[i]);
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

/**
 * The first ISBN among some identifiers.
 *
 * `dc:identifier` holds whatever the publisher put there — a UUID, a URL, an
 * internal code — so candidates are checksummed rather than pattern-matched.
 * An unvalidated ten-digit run would happily turn an internal catalogue number
 * into an ISBN, and nothing downstream would know it was invented.
 */
export function findIsbn(values: readonly string[]): string | undefined {
  for (const value of values) {
    const candidates = value.matchAll(
      /\b(?:97[89][\d-]{10,14}|[\d-]{9,12}[\dX])\b/gi,
    );
    for (const candidate of candidates) {
      const digits = candidate[0].replace(/-/g, "").toUpperCase();
      if (
        digits.length === 13 &&
        /^\d{13}$/.test(digits) &&
        validIsbn13(digits)
      ) {
        return digits;
      }
      if (
        digits.length === 10 &&
        /^\d{9}[\dX]$/.test(digits) &&
        validIsbn10(digits)
      ) {
        return digits;
      }
    }
  }
  return undefined;
}

/**
 * Splits a keyword field into subjects.
 *
 * One field, and every tool picks its own separator. Commas are safe here in a
 * way they are not for authors, because a keyword is not a name.
 */
export function splitSubjects(value: string): string[] {
  return value
    .split(/\s*[;,]\s*|\n+/)
    .map((subject) => subject.trim())
    .filter(Boolean);
}

/** Removes duplicates, ignoring case, keeping the first spelling of each. */
export function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
