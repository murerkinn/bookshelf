/**
 * Characters XML 1.0 cannot represent at all — the C0 controls other than tab,
 * newline and carriage return, plus two noncharacters.
 *
 * Not hypothetical: EPUB descriptions arrive with stray form feeds and vertical
 * tabs in them, and one of those makes an entire feed unparseable rather than
 * one entry wrong.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are the point — this is the set XML cannot carry
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

/**
 * XML text, from whatever a publisher happened to put in a book.
 *
 * The unrepresentable characters go first and are dropped rather than escaped,
 * because there is no escape for them. Then the five entities, `&` ahead of the
 * rest so the escapes it writes are not escaped a second time.
 */
export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** An attribute, or nothing at all where there is no value to write. */
export function attribute(
  name: string,
  value: string | number | undefined,
): string {
  return value === undefined || value === ""
    ? ""
    : ` ${name}="${escapeXml(String(value))}"`;
}

/** An element with escaped text, or nothing where there is no text. */
export function element(
  name: string,
  value: string | number | undefined,
  attributes = "",
): string {
  return value === undefined || value === ""
    ? ""
    : `<${name}${attributes}>${escapeXml(String(value))}</${name}>`;
}

/**
 * A description as plain text: tags removed, the handful of entities a
 * publisher's HTML actually uses resolved, and whitespace collapsed.
 *
 * Atom's `<summary type="text">` means what it says, and shipping markup
 * through it puts angle brackets on the screen of every client that believes
 * the declaration. The unabridged original still goes out as html, in
 * `<content>`, for the clients that render that instead.
 */
export function plainText(html: string, limit = 500): string {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    // Last, so an `&amp;lt;` does not go on to become a `<`.
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= limit) return text;

  // Cut at a word rather than mid-word, where there is one close enough to cut
  // at — a limit landing inside a very long token is not worth honouring.
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
