import { headers } from "next/headers";

/** What the shelf calls itself, wherever a name is wanted. */
export const SITE_NAME = "Bookshelf";

/** One sentence, shared by the metadata, the manifest and the OG image. */
export const SITE_DESCRIPTION = "Browse, read and download your ebook library.";

/**
 * The Open Graph fields every page shares.
 *
 * Spread into each page's own `openGraph` rather than left to be inherited,
 * because a child's `openGraph` replaces its parent's outright instead of
 * merging into it — anything not repeated goes missing from the tags.
 */
export const OG_BASE = {
  siteName: SITE_NAME,
  locale: "en_US",
} as const;

/** Localhost in any of its spellings, which is the one host served over http. */
function isLocal(host: string): boolean {
  const name = host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** A header a proxy may have written as a list; the first entry is ours. */
function first(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

/**
 * The origin this instance is reached at, for the absolute URLs that link
 * previews and canonical tags require.
 *
 * Read from the request rather than configured, so a self-hosted shelf
 * describes itself correctly wherever it is served from — the same reasoning
 * that keeps the provider out of the app. A hardcoded domain would have every
 * instance advertising someone else's.
 *
 * BOOKSHELF_SITE_URL wins where the public address is not the one the app is
 * reached at: behind a proxy that does not say so, or where previews should
 * name a canonical host rather than whichever alias was used.
 */
export async function siteOrigin(): Promise<URL> {
  const configured = process.env.BOOKSHELF_SITE_URL?.trim();
  if (configured) {
    try {
      return new URL(configured);
    } catch {
      // A malformed override is worth ignoring rather than failing a render;
      // the request itself still knows where it arrived.
    }
  }

  const list = await headers();
  const host =
    first(list.get("x-forwarded-host")) ??
    first(list.get("host")) ??
    "localhost:3000";

  return new URL(
    `${first(list.get("x-forwarded-proto")) ?? (isLocal(host) ? "http" : "https")}://${host}`,
  );
}
