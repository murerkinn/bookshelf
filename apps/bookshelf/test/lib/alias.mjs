import { statSync } from "node:fs";
import { registerHooks } from "node:module";

/**
 * Teaches Node the app's `@/` import alias.
 *
 * The app imports itself as `@/services/...`, which is a TypeScript path
 * mapping that Next resolves at build time and Node knows nothing about. Type
 * stripping erases `import type`, so this went unnoticed for as long as the
 * services only imported types across that alias — the moment one of them
 * imported a value, every test that loads a service stopped resolving.
 *
 * Note that the tests living inside the app does not remove the need for this:
 * the alias is resolved by Next at build time, and `node --test` does no
 * building. The app's own services import each other across it at run time, so
 * something has to teach Node the mapping whatever directory the tests sit in.
 *
 * The alternative was to make the app use relative paths in the files the tests
 * happen to reach, which is a source change in service of a test runner and
 * inconsistent with every other import in the app. A resolver belongs in the
 * test setup instead, which is where this is: the app's `test` script loads it
 * with `--import`.
 */
const SOURCE = new URL("../../src/", import.meta.url);

/** What Next tries, in the order it tries them, for an extensionless path. */
const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts"];

function resolveAlias(specifier) {
  for (const extension of EXTENSIONS) {
    const candidate = new URL(`${specifier.slice(2)}${extension}`, SOURCE);
    try {
      if (statSync(candidate).isFile()) return candidate.href;
    } catch {
      // Not this one.
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const url = resolveAlias(specifier);
      // No `format`: Node works it out from the extension, which is what lets a
      // `.ts` file go through type stripping rather than being read as JS.
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
