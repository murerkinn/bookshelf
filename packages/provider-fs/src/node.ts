import { createReadStream, type Stats } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  contentTypeFor,
  type Storage,
  type StorageAdmin,
  type StoredContent,
  type StoredObject,
} from "@bookshelf/core";
import type { FsConfig } from "./manifest.js";

type Config = FsConfig & { projectRoot?: string };

function rootOf(config: Config): string {
  return path.resolve(config.projectRoot ?? process.cwd(), config.directory);
}

/**
 * A key resolved to a path inside the library, or null if it would escape.
 *
 * Keys reach this provider from URLs, so this is a security boundary rather
 * than a tidiness check: `../../etc/passwd` must not resolve, and neither must
 * an absolute key, which `path.resolve` would otherwise honour outright.
 */
function resolveKey(root: string, key: string): string | null {
  if (key.includes("\0")) return null;

  const target = path.resolve(root, key);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!target.startsWith(prefix)) return null;

  return target;
}

/** Bare entity tag, with any weak marker and quotes removed. */
function normaliseEtag(etag: string): string {
  return etag.trim().replace(/^W\//, "").replace(/"/g, "");
}

/**
 * A filesystem records no entity tag, so one is derived from the size and
 * modification time. That changes exactly when the bytes are replaced, which is
 * all a validator has to promise.
 */
function describe(key: string, stats: Stats): StoredObject {
  return {
    key,
    size: stats.size,
    etag: `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    uploadedAt: stats.mtime,
    // Nowhere to store a content type, so it comes from the key. The shared
    // table means this lands on the same answer an uploading provider recorded.
    contentType: contentTypeFor(key),
  };
}

/** Stats for a key, or null when it is missing or is not a file. */
async function statFile(file: string): Promise<Stats | null> {
  try {
    const stats = await stat(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

class FsStorage implements Storage {
  constructor(private readonly root: string) {}

  async head(key: string): Promise<StoredObject | null> {
    const file = resolveKey(this.root, key);
    if (!file) return null;

    const stats = await statFile(file);
    return stats ? describe(key, stats) : null;
  }

  async read(
    key: string,
    options?: { ifNoneMatch?: string },
  ): Promise<StoredContent | null> {
    const file = resolveKey(this.root, key);
    if (!file) return null;

    const stats = await statFile(file);
    if (!stats) return null;

    const object = describe(key, stats);
    if (
      options?.ifNoneMatch &&
      normaliseEtag(options.ifNoneMatch) === normaliseEtag(object.etag)
    ) {
      // Matched, so the body is never opened — the caller answers 304.
      return { object, body: null };
    }

    return {
      object,
      body: Readable.toWeb(
        createReadStream(file),
      ) as ReadableStream<Uint8Array>,
    };
  }

  async readBytes(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const file = resolveKey(this.root, key);
    if (!file) return null;

    try {
      const buffer = await readFile(file);
      return new Uint8Array(
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ),
      );
    } catch {
      return null;
    }
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    if (length <= 0) return null;

    const file = resolveKey(this.root, key);
    if (!file) return null;

    const stats = await statFile(file);
    if (!stats || offset >= stats.size) return null;

    // Clamped rather than refused, so an over-read behaves as it does against
    // object storage, which is what the ZIP reader relies on.
    const size = Math.min(length, stats.size - offset);
    const handle = await open(file, "r");
    try {
      const buffer = new Uint8Array(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      return bytesRead === size ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

/** The library as the app reads it: a directory it can open files in. */
export function createStorage(config: Config): Storage {
  return new FsStorage(rootOf(config));
}

/** Every file under `directory`, as the keys they occupy. */
async function walk(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, {
      withFileTypes: true,
      recursive: true,
    });

    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join("/"),
      )
      .sort();
  } catch {
    // A destination that does not exist yet holds nothing, which is not an
    // error — the first publish creates it.
    return [];
  }
}

/**
 * Removes a directory left empty by a deletion, and its parents, up to but
 * never including the library root. Without this, deleting a book would leave
 * its folder behind for good.
 */
async function pruneEmpty(root: string, from: string): Promise<void> {
  let directory = path.dirname(from);

  while (directory.startsWith(root) && directory !== root) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
    directory = path.dirname(directory);
  }
}

/**
 * The library as the sync CLI manages it.
 *
 * Every optional capability is implemented, because a directory supports all of
 * them: it can be created, walked and emptied. That makes `--force` exact here,
 * where R2 over wrangler can only clear what its last catalog recorded.
 */
export function createAdmin(config: Config): StorageAdmin {
  const root = rootOf(config);

  function pathFor(key: string): string {
    const file = resolveKey(root, key);
    if (!file) throw new Error(`key escapes the library: ${key}`);
    return file;
  }

  return {
    name: `filesystem → ${root}`,

    async create() {
      const stats = await stat(root).catch(() => null);
      if (stats?.isDirectory()) return false;

      await mkdir(root, { recursive: true });
      return true;
    },

    async read(key) {
      try {
        return await readFile(pathFor(key));
      } catch {
        return null;
      }
    },

    async put(key, file) {
      const target = pathFor(key);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { force: true });

      // Hard-linked where the filesystem allows it, so publishing a 40 MB book
      // to a local destination costs an inode rather than 40 MB.
      try {
        await link(file, target);
      } catch {
        await copyFile(file, target);
      }
    },

    async remove(key) {
      const target = pathFor(key);
      await rm(target, { force: true });
      await pruneEmpty(root, target);
    },

    async list() {
      return walk(root);
    },

    async removeAll() {
      const keys = await walk(root);

      for (const entry of await readdir(root).catch(() => [])) {
        await rm(path.join(root, entry), { recursive: true, force: true });
      }

      return keys.length;
    },
  };
}
