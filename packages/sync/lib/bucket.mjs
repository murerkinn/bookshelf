import { readdir } from "node:fs/promises";
import path from "node:path";
import { CATALOG_FILE, METADATA_FILE } from "./config.mjs";
import { contentTypeFor } from "./mime.mjs";
import { pool, retry } from "./util.mjs";

/** Used when a target does not state its own safe write concurrency. */
const DEFAULT_CONCURRENCY = 4;

/** Every file in the built tree, as the keys they will occupy. */
async function localKeys(outDir) {
  const entries = await readdir(outDir, {
    withFileTypes: true,
    recursive: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return {
        key: path.relative(outDir, file).split(path.sep).join("/"),
        file,
        contentType: contentTypeFor(entry.name),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * What the target holds now.
 *
 * Providers that can enumerate say so directly. For those that cannot, the
 * catalog published last time describes everything this script wrote, which is
 * exact for a bucket only this script manages — and blind to anything put there
 * by other means.
 */
async function remoteKeys(target) {
  if (target.list) {
    return { keys: await target.list(), exact: true };
  }

  const raw = await target.read(CATALOG_FILE);
  if (!raw) return { keys: [], exact: false };

  try {
    const catalog = JSON.parse(raw.toString("utf8"));
    const keys = [CATALOG_FILE];
    for (const book of catalog.books ?? []) {
      keys.push(`${book.id}/${METADATA_FILE}`);
      if (book.cover) keys.push(`${book.id}/${book.cover}`);
      for (const format of book.formats ?? []) {
        keys.push(`${book.id}/${format.file}`);
      }
    }
    return { keys, exact: false };
  } catch {
    return { keys: [], exact: false };
  }
}

/**
 * Publishes the built tree.
 *
 * Normally every file is uploaded and anything the previous catalog listed but
 * this one does not is removed, so deleting a book locally deletes it remotely.
 * With `force`, the previous contents are cleared first — a clean slate for
 * when the bucket has drifted out of step.
 */
export async function syncLibrary(target, outDir, { force = false, log }) {
  const concurrency = target.concurrency ?? DEFAULT_CONCURRENCY;
  const desired = await localKeys(outDir);
  const { keys: previous, exact } = await remoteKeys(target);

  const wanted = new Set(desired.map((entry) => entry.key));
  const stale = previous.filter((key) => force || !wanted.has(key));

  if (stale.length) {
    log(
      force
        ? `Clearing ${stale.length} objects${exact ? "" : " recorded in the published catalog"}…`
        : `Removing ${stale.length} objects no longer in the library…`,
    );
    await pool(stale, concurrency, (key) =>
      retry(() => target.remove(key)).catch((error) => {
        log(`  warn   could not delete ${key} (${error.message.trim()})`);
      }),
    );
  }

  log(`Uploading ${desired.length} objects to ${target.name}…`);
  let done = 0;
  let failed = 0;

  await pool(desired, concurrency, async (entry) => {
    try {
      await retry(() => target.put(entry.key, entry.file, entry.contentType));
      done++;
      if (done % 25 === 0) log(`  ${done}/${desired.length}`);
    } catch (error) {
      failed++;
      log(`  fail   ${entry.key} (${error.message.trim().split("\n")[0]})`);
    }
  });

  return { uploaded: done, removed: stale.length, failed, exact };
}
