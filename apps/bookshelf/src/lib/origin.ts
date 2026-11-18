import { headers } from "next/headers";
import { forwardedOrigin } from "@/lib/forwarded";

/**
 * Where this request arrived, which is a different question from what the
 * shelf calls itself — and the reason the two are separate modules. This one
 * reads `next/headers` and so can only run inside a request; `site.ts` is
 * constants, and anything may import it.
 */

/**
 * The origin this instance is reached at, for the absolute URLs that link
 * previews, canonical tags and OPDS feeds require.
 *
 * Read from the request rather than configured, so a self-hosted shelf
 * describes itself correctly wherever it is served from — the same reasoning
 * that keeps the provider out of the app. A hardcoded domain would have every
 * instance advertising someone else's.
 *
 * BOOKSHELF_SITE_URL wins where the public address is not the one the app is
 * reached at: behind a proxy that does not say so, or where previews should
 * name a canonical host rather than whichever alias was used. It is also the
 * only answer a client cannot influence — the request's own is built from
 * headers anyone can send, which `forwardedOrigin` narrows to a scheme and a
 * host but cannot vouch for.
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

  return forwardedOrigin(await headers());
}
