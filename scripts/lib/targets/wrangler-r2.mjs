import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "../config.mjs";

const run = promisify(execFile);

/**
 * Wrangler colours its output. Built from a char code rather than written as an
 * escape in the literal, which reads as a stray control character.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Publishes to Cloudflare R2 through the wrangler CLI, which is already a
 * dependency and reuses whatever login wrangler already has — no access keys
 * to create.
 *
 * Note what it cannot do: wrangler exposes only get, put and delete for
 * objects, with no way to enumerate a bucket. This target therefore leaves
 * `list` undefined, and the sync falls back to working out the previous
 * contents from the catalog it published last time.
 */
export function createWranglerR2Target({ bucket, jurisdiction, local }) {
  const scope = local ? "--local" : "--remote";
  const base = jurisdiction && !local ? ["-J", jurisdiction] : [];

  async function wrangler(args, options = {}) {
    try {
      return await run("npx", ["wrangler", ...args], {
        cwd: ROOT,
        maxBuffer: 1024 * 1024 * 256,
        ...options,
      });
    } catch (error) {
      // execFile reports only "Command failed"; wrangler says what went wrong
      // on stderr, and that is the part worth seeing.
      const detail = String(error.stderr ?? "")
        .split("\n")
        .map((line) => line.replace(ANSI, "").trim())
        .filter((line) => line && !line.startsWith("▲"))
        .slice(-2)
        .join(" ");
      throw new Error(detail || error.message);
    }
  }

  return {
    name: `wrangler → ${bucket}${jurisdiction ? ` (${jurisdiction})` : ""}${local ? " [local]" : ""}`,

    // Every local invocation boots a miniflare runtime that takes an exclusive
    // lock on the shared state file, so parallel writes fail with SQLITE_BUSY.
    // Remote writes are plain HTTP and parallelise, though each still pays for
    // a wrangler start, so the useful ceiling is low.
    concurrency: local ? 1 : 4,

    async read(key) {
      try {
        const { stdout } = await wrangler(
          ["r2", "object", "get", `${bucket}/${key}`, "--pipe", scope, ...base],
          { encoding: "buffer" },
        );
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
