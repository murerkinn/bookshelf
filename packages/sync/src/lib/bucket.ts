import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  CATALOG_FILE,
  type Catalog,
  contentTypeFor,
  METADATA_FILE,
  type StorageAdmin,
} from "@bookshelf/core";
import { messageOf, pool, retry } from "./util.js";

/** One file in the built tree, and where it is going. */
type Upload = { key: string; file: string; contentType: string };

/** What a publish did. */
export type SyncResult = {
  uploaded: number;
  removed: number;
  failed: number;
  /**
   * Whether the removals were exact. False where the provider cannot enumerate
   * its destination, so what was cleared came from the last published catalog
   * rather than from looking.
   */
  exact: boolean;
};

export type SyncOptions = {
  force?: boolean;
  log: (message: string) => void;
};

/** Used when a provider does not state its own safe write concurrency. */
const DEFAULT_CONCURRENCY = 4;

/** Every file in the built tree, as the keys they will occupy. */
async function localKeys(outDir: string): Promise<Upload[]> {
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
 * What the destination holds now.
 *
 * Providers that can enumerate say so directly. For those that cannot, the
 * catalog published last time describes everything this script wrote, which is
 * exact for a destination only this script manages — and blind to anything put
 * there by other means.
 */
async function remoteKeys(
  admin: StorageAdmin,
): Promise<{ keys: string[]; exact: boolean }> {
  if (admin.list) {
    return { keys: await admin.list(), exact: true };
  }

  const raw = await admin.read(CATALOG_FILE);
  if (!raw) return { keys: [], exact: false };

  try {
    const catalog = JSON.parse(new TextDecoder().decode(raw)) as Catalog;
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
 * when the destination has drifted out of step.
 *
 * How exact that clean slate is depends on the provider. One that can wipe its
 * destination does; one that cannot falls back to deleting the keys it knows
 * about, and says so rather than implying more than it did.
 */
export async function syncLibrary(
  admin: StorageAdmin,
  outDir: string,
  { force = false, log }: SyncOptions,
): Promise<SyncResult> {
  const concurrency = admin.concurrency ?? DEFAULT_CONCURRENCY;
  const desired = await localKeys(outDir);

  let removed = 0;
  let exact: boolean;

  if (force && admin.removeAll) {
    log(`Clearing everything in ${admin.name}…`);
    removed = await admin.removeAll();
    exact = true;
  } else {
    const { keys: previous, exact: enumerated } = await remoteKeys(admin);
    exact = enumerated;

    const wanted = new Set(desired.map((entry) => entry.key));
    const stale = previous.filter((key) => force || !wanted.has(key));
    removed = stale.length;

    if (stale.length) {
      log(
        force
          ? `Clearing ${stale.length} objects${exact ? "" : " recorded in the published catalog"}…`
          : `Removing ${stale.length} objects no longer in the library…`,
      );
      await pool(stale, concurrency, (key) =>
        retry(() => admin.remove(key)).catch((error: unknown) => {
          log(`  warn   could not delete ${key} (${messageOf(error).trim()})`);
        }),
      );
    }
  }

  log(`Uploading ${desired.length} objects to ${admin.name}…`);
  let done = 0;
  let failed = 0;

  await pool(desired, concurrency, async (entry) => {
    try {
      await retry(() => admin.put(entry.key, entry.file, entry.contentType));
      done++;
      if (done % 25 === 0) log(`  ${done}/${desired.length}`);
    } catch (error) {
      failed++;
      log(`  fail   ${entry.key} (${messageOf(error).trim().split("\n")[0]})`);
    }
  });

  return { uploaded: done, removed, failed, exact };
}
