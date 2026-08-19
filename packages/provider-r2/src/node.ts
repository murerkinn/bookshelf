import { execFile } from "node:child_process";
import type { StorageAdmin } from "@bookshelf/core";
import { resolveConfig } from "./config.js";
import type { R2Config } from "./manifest.js";

/**
 * Wrangler colours its output. Built from a char code rather than written as an
 * escape in the literal, which reads as a stray control character.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

type Output = { stdout: Buffer; stderr: Buffer };

function exec(args: string[], cwd: string): Promise<Output> {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      ["wrangler", ...args],
      { cwd, maxBuffer: 1024 * 1024 * 256, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

/** The last couple of lines wrangler wrote to stderr, which say what went wrong. */
function detail(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string }).stderr;
  return String(stderr ?? "")
    .split("\n")
    .map((line) => line.replace(ANSI, "").trim())
    .filter((line) => line && !line.startsWith("▲"))
    .slice(-2)
    .join(" ");
}

/**
 * Cloudflare R2 as the sync CLI writes it, through the wrangler executable —
 * already a dependency, and it reuses whatever login wrangler has, so there are
 * no access keys to create.
 *
 * Note what it cannot do: wrangler exposes only get, put and delete for
 * objects, with no way to enumerate a bucket. This admin therefore leaves
 * `list` and `removeAll` undefined, and the sync falls back to working out the
 * previous contents from the catalog it published last time.
 */
export async function createAdmin(
  config: R2Config & { projectRoot?: string },
): Promise<StorageAdmin> {
  const {
    bucket,
    jurisdiction,
    cwd,
    warnings,
    local = false,
  } = await resolveConfig(config);
  const scope = local ? "--local" : "--remote";
  const base = jurisdiction && !local ? ["-J", jurisdiction] : [];

  async function wrangler(args: string[]): Promise<Output> {
    try {
      return await exec(args, cwd);
    } catch (error) {
      // execFile reports only "Command failed"; wrangler says what went wrong
      // on stderr, and that is the part worth seeing.
      throw new Error(detail(error) || (error as Error).message);
    }
  }

  return {
    warnings,

    name: `wrangler → ${bucket}${jurisdiction ? ` (${jurisdiction})` : ""}${local ? " [local]" : ""}`,

    // Every local invocation boots a miniflare runtime that takes an exclusive
    // lock on the shared state file, so parallel writes fail with SQLITE_BUSY.
    // Remote writes are plain HTTP and parallelise, though each still pays for
    // a wrangler start, so the useful ceiling is low.
    concurrency: local ? 1 : 4,

    async create() {
      // The local bucket is whatever miniflare makes on first write.
      if (local) return false;

      try {
        await wrangler(["r2", "bucket", "create", bucket, ...base]);
        return true;
      } catch (error) {
        if (/already exists|already owned/i.test((error as Error).message)) {
          return false;
        }
        throw error;
      }
    },

    async read(key) {
      try {
        const { stdout } = await wrangler([
          "r2",
          "object",
          "get",
          `${bucket}/${key}`,
          "--pipe",
          scope,
          ...base,
        ]);
        return stdout?.length ? stdout : null;
      } catch {
        // Missing objects and auth failures look the same here; the caller
        // treats "nothing there" as an empty previous state.
        return null;
      }
    },

    async put(key, file, contentType) {
      await wrangler([
        "r2",
        "object",
        "put",
        `${bucket}/${key}`,
        "--file",
        file,
        "--content-type",
        contentType,
        scope,
        ...base,
      ]);
    },

    async remove(key) {
      await wrangler([
        "r2",
        "object",
        "delete",
        `${bucket}/${key}`,
        scope,
        ...base,
      ]);
    },
  };
}
