import type { RateLimits } from "@/services/ports/limits";

/**
 * Who the limiter is counting.
 *
 * `CF-Connecting-IP` rather than `X-Forwarded-For`: Cloudflare sets the former
 * itself on the way in and overwrites whatever the client claimed, so it is the
 * one header here that cannot be chosen by the visitor being limited. A key a
 * caller can pick is not a limit.
 *
 * Not the address verbatim, though, because over IPv6 an address is not a
 * visitor. A single host is routinely handed a whole /64 and may source each
 * request from a different address in it, so counting addresses would give it
 * 2^64 allowances. The /64 is the smallest block one subscriber reliably holds,
 * and so the key for an IPv6 visitor is that. An IPv4 address stays whole: one
 * is all a visitor normally gets, and behind a NAT it is already shared.
 *
 * Everything with no such header shares one bucket. That is not a Cloudflare
 * request — a health check on the loopback, `next dev`, a test — and lumping
 * them together is safe precisely because none of them is the public internet.
 */
export function visitorKey(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP");
  return address ? addressKey(address) : "unknown";
}

/**
 * The part of an address that names who is asking: an IPv4 address whole, an
 * IPv6 address as its /64.
 *
 * The /64 has to be read out of the parsed address rather than off the front of
 * the string, since one address has many spellings — `2001:db8::1` and
 * `2001:0DB8:0:0::1` are the same host, and a key that told them apart would be
 * another allowance to be had for the asking. An IPv4 client reaching an IPv6
 * socket arrives as `::ffff:a.b.c.d`, and is keyed as the IPv4 address it is,
 * not as the /64 that every such client would otherwise share.
 *
 * Anything that does not parse is returned as it came. Cloudflare does not send
 * such a thing, and if it ever did, a key per odd string is what the limiter did
 * before, rather than lumping every such visitor in with the others.
 */
function addressKey(raw: string): string {
  const address = raw.trim();
  if (!address.includes(":")) return address;

  const groups = parseIPv6(address);
  if (!groups) return address;

  const isMappedIPv4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (isMappedIPv4) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff]
      .map(String)
      .join(".");
  }

  const prefix = groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":");
  return `${prefix}::/64`;
}

/** An IPv6 address as its eight 16-bit groups, or null if it is not one. */
function parseIPv6(text: string): number[] | null {
  // A zone (`fe80::1%eth0`) names an interface on the receiving host, not
  // anything about the sender.
  const address = text.split("%")[0].toLowerCase();

  const halves = address.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  // The last 32 bits may be written as a dotted IPv4 address.
  const last = halves.length === 2 ? tail : head;
  if (last.length > 0 && last[last.length - 1].includes(".")) {
    const quad = parseIPv4(last.pop() as string);
    if (!quad) return null;
    last.push(
      ((quad[0] << 8) | quad[1]).toString(16),
      ((quad[2] << 8) | quad[3]).toString(16),
    );
  }

  const written = [...head, ...tail];
  if (!written.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;

  const missing = 8 - written.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  return [...head, ...Array(missing).fill("0"), ...tail].map((group) =>
    Number.parseInt(group, 16),
  );
}

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  if (!parts.every((part) => /^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** What a route answers a visitor who has asked for too much. */
export function tooManyRequests(): Response {
  return new Response("Too many requests", {
    status: 429,
    headers: {
      "Retry-After": "60",
    },
  });
}

/**
 * The gate in front of a route's bucket access: null to go ahead, or the
 * response to send instead.
 *
 * Deliberately not a boolean. `if (!allowed) return tooManyRequests()` is one
 * inverted condition away from a route that reads the answer and carries on
 * regardless, and this shape gives the caller nothing it can ignore — the only
 * thing to do with a response is return it.
 *
 * Call it as late as the route can: after the key has been checked, after the
 * response cache has been asked. A request that was never going to touch R2 —
 * a 404 from a malformed key, a cover served from the cache, a malformed body —
 * should not spend a visitor's allowance, or a shelf of covers would exhaust it
 * on the one page view that the cache made nearly free.
 */
export async function enforceR2RateLimit(
  request: Request,
  limits: RateLimits,
): Promise<Response | null> {
  const allowed = await limits.allowsR2(visitorKey(request));
  return allowed ? null : tooManyRequests();
}

/**
 * The second gate, for routes that hand over a whole file.
 *
 * Always after {@link enforceR2RateLimit} and never on its own: a download is
 * an R2 read too, and it should count as one before it is weighed as the
 * expensive thing it also is.
 */
export async function enforceDownloadRateLimit(
  request: Request,
  limits: RateLimits,
): Promise<Response | null> {
  const allowed = await limits.allowsDownload(visitorKey(request));
  return allowed ? null : tooManyRequests();
}
