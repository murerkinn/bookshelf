/**
 * What a request's headers say about where it arrived — read with suspicion.
 *
 * Kept apart from `origin.ts` so it is a pure function of the headers: that one
 * has to import `next/headers`, which nothing outside a Next request can load,
 * and this is the part worth testing.
 *
 * Every header here is whatever the client sent unless a proxy overwrote it,
 * and the app cannot tell which. Behind a reverse proxy that sets them they are
 * the only way to learn the public address without configuration, so they are
 * still read — but only what could be the scheme and host of a URL is
 * believed. Anything else falls back to the next-best answer instead of
 * becoming part of a link.
 */

/** The schemes a shelf is served over; a forwarded `javascript` is not one. */
const SCHEMES = new Set(["http", "https"]);

/**
 * A URL authority's host and port, minus anything that is not a host: a name
 * or IPv4 address, or a bracketed IPv6 literal, then an optional port. No
 * userinfo, path, query or whitespace, which is what would let a header carry
 * more of a URL than its host. Underscores are allowed because container
 * service names use them.
 */
const HOST =
  /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** The longest a DNS name can be, with room for a port. */
const MAX_HOST_LENGTH = 253 + ":65535".length;

/** Localhost in any of its spellings, which is the one host served over http. */
function isLocal(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** A header a proxy may have written as a list; the first entry is ours. */
function first(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

/**
 * The value, if it is a host. The pattern turns away what is not shaped like
 * one, and parsing turns away what is shaped like one and still is not — a
 * port past 65535, or a bracketed literal that is not an address.
 */
function host(value: string | undefined): string | undefined {
  return value &&
    value.length <= MAX_HOST_LENGTH &&
    HOST.test(value) &&
    URL.canParse(`http://${value}`)
    ? value
    : undefined;
}

function scheme(value: string | undefined): string | undefined {
  const lower = value?.toLowerCase();
  return lower && SCHEMES.has(lower) ? lower : undefined;
}

/**
 * The origin a request arrived at, by its `X-Forwarded-Host` and
 * `X-Forwarded-Proto`, then its `Host`.
 *
 * A forwarded host that is not a host falls back to `Host` rather than to
 * nothing, since that is still a statement of where the request arrived; a
 * forwarded scheme that is not http or https falls back to the guess made when
 * there is none.
 */
export function forwardedOrigin(headers: {
  get(name: string): string | null;
}): URL {
  const at =
    host(first(headers.get("x-forwarded-host"))) ??
    host(first(headers.get("host"))) ??
    "localhost:3000";
  const over =
    scheme(first(headers.get("x-forwarded-proto"))) ??
    (isLocal(at) ? "http" : "https");

  return new URL(`${over}://${at}`);
}
