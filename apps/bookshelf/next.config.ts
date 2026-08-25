import path from "node:path";
import { findConfigSync } from "@bookshelf/core/config";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/headers";

/**
 * Which provider holds the library is decided here, at build time, from the
 * same bookshelf.config.json the sync tool publishes through — so the two
 * cannot disagree about where the books are.
 *
 * It has to be build time rather than request time: on Workers there is no
 * filesystem to read a config file from, and the two modes are different
 * artifacts anyway — one Worker, one Node server. The values below are baked
 * into the bundle as defaults; BOOKSHELF_PROVIDER and BOOKSHELF_DIRECTORY still
 * override them at run time, for a deployment whose library sits somewhere
 * other than where it was built.
 */
function providerDefaults(): Record<string, string> {
  const found = findConfigSync(process.cwd());
  const storage = found?.config.storage ?? {};
  const directory = storage.directory;

  return {
    BOOKSHELF_PROVIDER_DEFAULT: String(storage.provider ?? "r2"),
    ...(found && typeof directory === "string"
      ? {
          BOOKSHELF_DIRECTORY_DEFAULT: path.resolve(found.root, directory),
        }
      : {}),
  };
}

const nextConfig: NextConfig = {
  env: providerDefaults(),

  headers: securityHeaders,
};

// Makes the Cloudflare bindings (R2, etc.) available to `next dev`.
initOpenNextCloudflareForDev();

export default nextConfig;
