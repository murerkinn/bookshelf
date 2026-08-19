/**
 * Resolving a provider means importing its package.
 *
 * The ids below are shorthands for the providers shipped with the project; any
 * other value is taken as a package specifier and imported as given, so a
 * provider written by someone else needs nothing added here — installing it and
 * naming it in the config is the whole integration.
 */
const BUILT_IN = {
  r2: "@bookshelf/provider-r2",
  fs: "@bookshelf/provider-fs",
};

export const BUILT_IN_IDS = Object.keys(BUILT_IN);

function specifier(id) {
  return BUILT_IN[id] ?? id;
}

async function load(id, subpath) {
  const from = `${specifier(id)}${subpath}`;
  try {
    return await import(from);
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `could not load provider "${id}" (tried ${from}).\n` +
          `Built in: ${BUILT_IN_IDS.join(", ")}. Anything else must be installed first.`,
      );
    }
    throw error;
  }
}

/** What a provider says about itself, without connecting to anything. */
export async function readManifest(id) {
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
export async function createAdmin(id, storage) {
  const module = await load(id, "/node");
  if (typeof module.createAdmin !== "function") {
    throw new Error(`provider "${id}" has no node entry point to publish with`);
  }
  return await module.createAdmin(storage);
}
