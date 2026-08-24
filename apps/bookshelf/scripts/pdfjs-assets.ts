/**
 * Puts pdf.js's runtime files where the browser can fetch them.
 *
 * The reader is bundled like any other client code, but pdf.js also asks for
 * files over HTTP at the moment it needs them, by URL rather than by import:
 * its worker, the predefined CMaps a CJK document names instead of embedding,
 * the fourteen standard fonts a PDF is allowed to assume, the WebAssembly for
 * JPEG 2000 and JBIG2 images, and a colour profile. A bundler never sees those
 * requests, so nothing puts the files in the output on its own.
 *
 * They are copied rather than committed because they belong to pdfjs-dist and
 * change with it — vendoring four megabytes of someone else's build would have
 * to be redone on every upgrade, and would go stale silently in between. The
 * version they came from is written alongside them, so an upgrade is noticed
 * and a second run is free.
 *
 * Nothing here is on the path to a first page: every one of these is fetched
 * only by a document that turns out to need it.
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Where pdfjs-dist unpacked, wherever npm decided to hoist it to. */
const root = path.dirname(require.resolve("pdfjs-dist/package.json"));

const target = path.join(import.meta.dirname, "..", "public", "pdfjs");

/** Records which pdfjs-dist the files came from, so a rerun can skip. */
const stamp = path.join(target, ".version");

/**
 * What to copy, and what to leave behind.
 *
 * `pdf.worker.min.mjs` is the minified worker: it is a megabyte either way and
 * the unminified one exists to be read, not shipped. `quickjs-eval.wasm` runs
 * the JavaScript embedded in PDF forms, which this reader does not execute —
 * a book is not an application, and half a megabyte of interpreter is a strange
 * thing to serve on the chance that one does something.
 */
const files = ["build/pdf.worker.min.mjs"];
const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];
const excluded = /^quickjs-eval\./;

function version(): string {
  const { version } = require("pdfjs-dist/package.json") as { version: string };
  return version;
}

async function current(): Promise<string | null> {
  try {
    return (await readFile(stamp, "utf8")).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const wanted = version();
  if ((await current()) === wanted) {
    console.log(`pdf.js ${wanted} assets are already in place`);
    return;
  }

  // Removed wholesale rather than copied over, so that a file an upgrade
  // dropped does not linger and get served.
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const file of files) {
    await cp(path.join(root, file), path.join(target, path.basename(file)));
  }

  for (const directory of directories) {
    await cp(path.join(root, directory), path.join(target, directory), {
      recursive: true,
      filter: (source) => !excluded.test(path.basename(source)),
    });
  }

  await writeFile(stamp, `${wanted}\n`);
  console.log(`Copied pdf.js ${wanted} assets into public/pdfjs`);
}

await main();
