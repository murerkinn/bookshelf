/**
 * JSON with comments, which is what both `bookshelf.config.jsonc` and
 * `wrangler.jsonc` are. One implementation because there were about to be
 * three: the CLI's config loader, the R2 provider reading a Worker's bindings,
 * and the app's build reading the same config the CLI does.
 */

/** Strips comments without mangling any that appear inside strings. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  return out;
}

export function parseJsonc<T>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}
