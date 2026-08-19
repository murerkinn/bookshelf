/**
 * The config file's shape. It is a contract between the sync tool and the app —
 * one publishes where the other reads — so it lives here rather than in either.
 */

/** Read in order; the first that exists wins. */
export const CONFIG_FILES = ["bookshelf.config.json", "bookshelf.config.jsonc"];

/**
 * Everything under `storage` except `provider` belongs to the provider named
 * there, so it is left open rather than enumerated.
 */
export type StorageConfig = {
  provider?: string;
  [option: string]: unknown;
};

export type BookshelfConfig = {
  input?: string;
  output?: string;
  coverHeight?: number;
  storage?: StorageConfig;
};
