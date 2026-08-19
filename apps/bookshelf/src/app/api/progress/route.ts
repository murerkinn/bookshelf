import { getServices } from "@/services/container";
import { activeProfile } from "@/services/session";

/** A CFI for a deep position is a couple of hundred characters at most. */
const MAX_FIELD_LENGTH = 1024;

function field(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, MAX_FIELD_LENGTH)
    : undefined;
}

/**
 * Records where a profile got to in a book.
 *
 * A route handler rather than a server action because the reader also sends
 * this from `pagehide`, where only `sendBeacon` is reliable, and a beacon can
 * only post to a URL.
 *
 * The answer says whether it was stored. A client told `saved: false` stops
 * asking and keeps its position in the browser, which is what happens against
 * a library the app cannot write to.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "expected JSON" }, { status: 400 });
  }

  const body = (payload ?? {}) as Record<string, unknown>;
  const bookId = field(body.bookId);
  if (!bookId) {
    return Response.json({ error: "bookId is required" }, { status: 400 });
  }

  const { catalog, progress } = await getServices();

  // Checked against the catalog rather than trusted, so the progress file
  // cannot be grown a key at a time by anything that can post to this URL.
  if (!(await catalog.find(bookId))) {
    return Response.json({ error: "no such book" }, { status: 404 });
  }

  const profile = await activeProfile();
  const saved = await progress.save(profile.id, bookId, {
    cfi: field(body.cfi),
    href: field(body.href),
  });

  return Response.json({ saved }, { status: saved ? 200 : 202 });
}
