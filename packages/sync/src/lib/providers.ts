import type { ProviderManifest, StorageAdmin } from "@bookshelf/core";
import { codeOf } from "./util.js";

/**
 * Resolving a provider means importing its package.
 *
 * The ids below are shorthands for the providers shipped with the project; any
 * other value is taken as a package specifier and imported as given, so a
 * provider written by someone else needs nothing added here — installing it and
 * naming it in the config is the whole integration.
 */
const BUILT_IN: Record<string, string> = {
  r2: "@bookshelf/provider-r2",
  fs: "@bookshelf/provider-fs",
};

export const BUILT_IN_IDS = Object.keys(BUILT_IN);

/**
 * What a provider package may export. Unknown at compile time by design — the
 * whole point is that the package is named in configuration — so what comes back
 * is checked before it is used rather than asserted.
 */
type ProviderModule = {
  manifest?: ProviderManifest;
  createAdmin?: (
    storage: Record<string, unknown>,
  ) => StorageAdmin | Promise<StorageAdmin>;
};

function specifier(id: string): string {
  return BUILT_IN[id] ?? id;
}

async function load(id: string, subpath: string): Promise<ProviderModule> {
  const from = `${specifier(id)}${subpath}`;
  try {
    return (await import(from)) as ProviderModule;
  } catch (error) {
    if (codeOf(error) === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `could not load provider "${id}" (tried ${from}).\n` +
          `Built in: ${BUILT_IN_IDS.join(", ")}. Anything else must be installed first.`,
      );
    }
    throw error;
  }
}

/** What a provider says about itself, without connecting to anything. */
export async function readManifest(id: string): Promise<ProviderManifest> {
  const { manifest } = await load(id, "");
  if (!manifest) {
    throw new Error(`provider "${id}" exports no manifest`);
  }
  return manifest;
}

/**
 * The managing half of a provider, built from the `storage` block of the
 * config. Everything in that block beyond `provider` belongs to the provider,
 * which is why it is passed through whole rather than picked apart here.
 */
export async function createAdmin(
  id: string,
  storage: Record<string, unknown>,
): Promise<StorageAdmin> {
  const module = await load(id, "/node");
  if (typeof module.createAdmin !== "function") {
    throw new Error(`provider "${id}" has no node entry point to publish with`);
  }
  return await module.createAdmin(storage);
}
