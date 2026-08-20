import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FILES, parseJsonc } from "@bookshelf/core";

/**
 * Where a library comes from and where it goes, read from a config file rather
 * than fixed in the source.
 *
 * The file is optional — the defaults below are the conventional layout — and
 * is found by walking up from the working directory, so the CLI behaves the
 * same whether it is run from the project root or from inside a workspace.
 * Its names and shape come from @bookshelf/core, because the app's build reads
 * the same file to learn which provider it is being built for.
 */
export { CONFIG_FILES };
export const DEFAULTS = {
  /** Drop books here. */
  input: "books",
  /** The tree to upload is built here. Regenerated on every run. */
  output: "library",
  /** 4x the 60px slot the shelf renders covers into, so they stay sharp. */
  coverHeight: 240,
  storage: {
    provider: "r2",
  },
};

export const BOOK_EXTENSIONS = new Set([".epub", ".pdf"]);

async function readJsonc(file) {
  return parseJsonc(await readFile(file, "utf8"));
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readIfPresent(file) {
  try {
    return await readJsonc(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`could not read ${file}: ${error.message}`);
  }
}

/**
 * Walks up from `from` for the directory a project starts at.
 *
 * Only used when there is no config file. Without it the root would be the
 * working directory, and the CLI's working directory is its own package — so
 * a project with no config file would look for books inside node_modules
 * rather than beside its own package.json.
 */
async function findProjectRoot(from) {
  let directory = path.resolve(from);

  for (;;) {
    const manifest = await readIfPresent(path.join(directory, "package.json"));
    // A workspace root, or any project not itself a workspace member.
    if (manifest?.workspaces) return directory;
    if (await exists(path.join(directory, ".git"))) return directory;

    const parent = path.dirname(directory);
    if (parent === directory) return path.resolve(from);
    directory = parent;
  }
}

/** Walks up from `from` for the first directory holding a config file. */
async function findConfig(from) {
  let directory = path.resolve(from);

  for (;;) {
    for (const name of CONFIG_FILES) {
      const file = path.join(directory, name);
      const config = await readIfPresent(file);
      if (config) return { file, config, root: directory };
    }

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * Resolves the configuration for a run. Paths come back absolute, so nothing
 * downstream has to know where the config file was found.
 */
export async function loadConfig({ cwd = process.cwd() } = {}) {
  const found = await findConfig(cwd);
  const root = found?.root ?? (await findProjectRoot(cwd));
  const file = found?.config ?? {};
  const { provider = DEFAULTS.storage.provider, ...options } =
    file.storage ?? {};

  return {
    root,
    configFile: found?.file ?? null,
    inputDir: path.resolve(root, file.input ?? DEFAULTS.input),
    outputDir: path.resolve(root, file.output ?? DEFAULTS.output),
    coverHeight: file.coverHeight ?? DEFAULTS.coverHeight,
    /**
     * Everything but `provider` belongs to the provider, so it is passed
     * through whole rather than picked apart by a loader that cannot know what
     * any given provider wants. `projectRoot` comes along so a provider can
     * resolve its own relative paths against the project rather than the
     * process — named so that it cannot collide with a provider's own key.
     */
    storage: { provider, projectRoot: root, ...options },
  };
}
