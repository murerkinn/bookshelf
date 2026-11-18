import { enforceR2RateLimit } from "@/lib/rate-limit";
import { getServices } from "@/services/container";
import { isUnavailable } from "@/services/errors";
import { activeProfile } from "@/services/session";

/** A CFI for a deep position is a couple of hundred characters at most. */
const MAX_FIELD_LENGTH = 1024;

/**
 * Higher than any real book, and low enough that the stored number stays a
 * number. The reader clamps a page to the document it actually opened, so this
 * only has to keep nonsense out of the file rather than be exact.
 */
const MAX_PAGE = 1_000_000;

/**
 * The most a post is read before it is refused.
 *
 * The largest real one is a book id, a CFI and an href, each at most
 * {@link MAX_FIELD_LENGTH} characters, plus a page number. Even with every
 * field at full length in three-byte characters that is about 9 KiB, so this
 * leaves room without leaving much. It is checked on the way in rather than
 * after parsing: anybody can post here, and a body of a few megabytes costs
 * the server many times that in memory once it is parsed.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * The body as text, or null if it is longer than `limit` bytes.
 *
 * A declared length is believed when it is too long, never when it is short:
 * a chunked body declares nothing, and a lying one is caught by the count. The
 * stream is cancelled once the count passes the limit, so the rest is never
 * buffered.
 */
async function readBody(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > limit) return null;
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();

    received += value.byteLength;
    if (received > limit) {
      void reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

function field(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : undefined;
}

/** A header a proxy may have written as a list; the first entry is ours. */
function first(value: string | null): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

/**
 * Whether a browser sent this on behalf of some other site's page.
 *
 * Without the check, any page a visitor opens can post here — a form or a
 * no-cors fetch needs no permission — and so reach a shelf on their network
 * that the page's author cannot. The visitor's cookie does not travel with it,
 * so what it writes lands on the first profile, but it is a write all the same.
 *
 * `Sec-Fetch-Site` is the browser's own word on it and cannot be set by a
 * page. Older browsers send only `Origin`, which is compared with the host the
 * request arrived at, by name rather than scheme because a proxy that
 * terminates TLS changes the one and not the other. A request with neither did
 * not come from a browser, and anything that is not a browser could post here
 * directly anyway.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin";

  const origin = request.headers.get("origin");
  if (!origin) return false;

  const host =
    first(request.headers.get("x-forwarded-host")) ??
    first(request.headers.get("host"));
  try {
    return new URL(origin).host !== host?.toLowerCase();
  } catch {
    // `null`, from a sandboxed frame or a redirect, is no origin of ours.
    return true;
  }
}

/** A page, counting from one — so zero is not one, and neither is a fraction. */
function pageNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PAGE
    ? value
    : undefined;
}

/**
 * Records where a profile got to in a book.
 *
 * A route handler rather than a server action because the reader also sends
 * this from `pagehide`, where only `sendBeacon` is reliable, and a beacon can
 * only post to a URL. A route handler gets none of the Origin check Next gives
 * a server action, so it does its own: a beacon from the reader is same-origin
 * like any other request it makes, and arrives saying so.
 *
 * The answer says whether it was stored. A client told `saved: false` stops
 * asking and keeps its position in the browser, which is what happens against
 * a library the app cannot write to.
 */
export async function POST(request: Request) {
  if (crossSite(request)) {
    return Response.json({ error: "cross-site" }, { status: 403 });
  }

  let payload: unknown;
  try {
    const text = await readBody(request, MAX_BODY_BYTES);
    if (text === null) {
      return Response.json({ error: "too large" }, { status: 413 });
    }
    payload = JSON.parse(text);
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }

  const body = (payload ?? {}) as Record<string, unknown>;
  const bookId = field(body.bookId);
  if (!bookId) {
    return Response.json({ error: "bookId is required" }, { status: 400 });
  }

  const { catalog, progress, limits } = await getServices();

  // After the body has been read and found to name a book, so a flood of
  // malformed posts is answered 400 without spending anybody's allowance —
  // and before the two reads and a write below, which are all of this route.
  const limited = await enforceR2RateLimit(request, limits);
  if (limited) return limited;

  try {
    // Checked against the catalog rather than trusted, so the progress file
    // cannot be grown a key at a time by anything that can post to this URL.
    if (!(await catalog.find(bookId))) {
      return Response.json({ error: "no such book" }, { status: 404 });
    }

    // The reader says which profile it was opened for, and that has to be the
    // one this browser is reading as now. They part when the cookie is switched
    // in another tab, or names a profile deleted from another device and so
    // falls back to the first: a reader left open would otherwise write its
    // place into the file of somebody who never opened the book. The fallback
    // is right for a page being rendered and wrong for a write, which is why it
    // is checked here rather than changed.
    const profile = await activeProfile();
    if (field(body.profileId) !== profile.id) {
      return Response.json({ saved: false }, { status: 409 });
    }

    const saved = await progress.save(profile.id, bookId, {
      cfi: field(body.cfi),
      href: field(body.href),
      page: pageNumber(body.page),
    });

    return Response.json({ saved }, { status: saved ? 200 : 202 });
  } catch (error) {
    if (!isUnavailable(error)) throw error;

    // The same answer as a library that cannot be written to, because to the
    // reader it is the same situation: keep the position in the browser and
    // try again later. `saved: false` is what it already knows how to handle.
    return Response.json(
      { saved: false },
      {
        status: 503,
        headers: { "retry-after": "5", "cache-control": "no-store" },
      },
    );
  }
}
