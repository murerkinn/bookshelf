import { headers } from "next/headers";

/**
 * Where this request arrived, which is a different question from what the
 * shelf calls itself — and the reason the two are separate modules. This one
 * reads `next/headers` and so can only run inside a request; `site.ts` is
 * constants, and anything may import it.
 */

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
