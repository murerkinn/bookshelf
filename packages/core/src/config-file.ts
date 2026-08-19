import { readFileSync } from "node:fs";
import path from "node:path";
import { type BookshelfConfig, CONFIG_FILES } from "./config.js";
import { parseJsonc } from "./jsonc.js";

/**
 * Finding the config file synchronously, for the places that cannot wait: a
 * build step reading the same file the CLI reads, so that the app and the sync
 * tool cannot disagree about which provider holds the library.
 *
 * Node only, and behind its own entry point, so nothing that ships to a runtime
 * without a filesystem can reach it.
 */
export type FoundConfig = {
  /** Absolute path to the file that was read. */
  file: string;
  /** The directory holding it — what relative paths inside resolve against. */
  root: string;
  config: BookshelfConfig;
};

export function findConfigSync(from: string): FoundConfig | null {
  let directory = path.resolve(from);

  for (;;) {
    for (const name of CONFIG_FILES) {
      const file = path.join(directory, name);
      try {
        return {
          file,
          root: directory,
          config: parseJsonc<BookshelfConfig>(readFileSync(file, "utf8")),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(
            `could not read ${file}: ${(error as Error).message}`,
          );
        }
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
