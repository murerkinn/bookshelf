import {
  contentRange,
  ifRangeMatches,
  normaliseEtag,
  parseBookKey,
  parseByteRange,
  unsatisfiedRange,
} from "@bookshelf/core";
import { serviceUnavailable } from "@/lib/http";
import { enforceDownloadRateLimit, enforceR2RateLimit } from "@/lib/rate-limit";
import { getServices } from "@/services/container";
import { reading } from "@/services/errors";

/**
 * The content types `?inline=1` is honoured for.
 *
 * An inline disposition asks the browser to render the object in this origin,
 * so the list is what can be rendered without running script here. A PDF goes
 * to the browser's own viewer; plain text is drawn as text. Anything else —
 * `text/html`, `image/svg+xml`, an XHTML document — would execute in the
 * shelf's origin against its cookies, so it is served as an attachment
 * regardless of what was asked for. The file still arrives; it just arrives as
 * a download.
 *
 * The type comes from the provider rather than from this app: R2 hands back
 * what was set at upload. The sync tool sets it from the extension, but the
 * bucket is not necessarily only ever written by the sync tool.
 */
const INLINE_CONTENT_TYPES = new Set(["application/pdf", "text/plain"]);

function mayInline(contentType: string): boolean {
  return INLINE_CONTENT_TYPES.has(
    contentType.split(";")[0].trim().toLowerCase(),
  );
}

/** RFC 6266 `filename` + `filename*`, so non-ASCII titles survive the trip. */
function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Serves a book file, whole or in part.
 *
 * Ranges are what make this worth more than a redirect to the object. A PDF
 * viewer given `Accept-Ranges: bytes` fetches the pages it is showing instead of
 * the whole book first — the same saving the EPUB reader gets from reading one
 * chapter out of an archive, except the browser does the asking. An interrupted
 * download resumes from where it stopped rather than starting again. And the
 * validator turns a re-request into a 304 instead of a second transfer.
 *
 * Everything here is answered from the object's own metadata, so nothing is
 * assumed about the provider beyond the contract: a provider that declines to
 * serve a range says so by returning the whole object, and this answers 200
 * rather than a 206 that would misdescribe its own body.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/download/[...key]">,
) {
  try {
    return await serve(request, ctx);
  } catch (error) {
    // A download that fails mid-stream cannot be recalled, but one that fails
    // before a byte is sent can still say why.
    return serviceUnavailable(error);
  }
}

async function serve(
  request: Request,
  ctx: RouteContext<"/download/[...key]">,
) {
  const { key } = await ctx.params;
  const objectKey = key.join("/");

  // Only a file inside a book's folder, and nothing else in the bucket. Without
  // this the URL is a read of any key the provider will answer for, including
  // the app's own state — `.bookshelf/profiles.json` names everyone reading
  // here, and `.bookshelf/progress/<profile>.json` says what they read and
  // where they are. Neither is a book, and neither has any business on a route
  // that serves books.
  const target = parseBookKey(objectKey);
  if (!target) {
    return new Response("Not found", { status: 404 });
  }

  // `?inline=1` lets the reader embed a format the browser can display itself,
  // such as a PDF, instead of prompting a download.
  const inline = new URL(request.url).searchParams.has("inline");
  const conditional = request.headers.get("if-none-match");
  const requestedRange = request.headers.get("range");

  const { storage, limits } = await getServices();

  // Both limits, in that order, with nothing between them and the bucket:
  // every path out of here leads to R2, so this is as late as the check gets.
  const overR2 = await enforceR2RateLimit(request, limits);
  if (overR2) return overR2;

  // Only a request for the whole file is a download. A ranged one is the PDF
  // reader turning a page — pdf.js fetches this URL a slice at a time — and
  // counting those against the download allowance would stop a book being read
  // long before it was finished. They are still counted above, which is what
  // bounds them; this second, tighter allowance is for carrying a book off.
  if (!requestedRange) {
    const overDownload = await enforceDownloadRateLimit(request, limits);
    if (overDownload) return overDownload;
  }

  // A range has to be resolved against the object's length — `bytes=-1024` and
  // an open-ended `bytes=1024-` both need it — so a ranged request costs a look
  // at the metadata first. A plain download does not, and does not pay for it.
  let wanted: ReturnType<typeof parseByteRange> = { kind: "whole" };
  if (requestedRange) {
    const object = await reading("a book", () => storage.head(objectKey));
    if (!object) return new Response("Not found", { status: 404 });

    // A resumed download names the version it already holds part of. If the
    // book has been republished since, continuing from an offset would splice
    // two different files together, so the range is declined and the whole of
    // the new one is served instead.
    if (ifRangeMatches(request.headers.get("if-range"), object.etag)) {
      wanted = parseByteRange(requestedRange, object.size);
    }

    if (wanted.kind === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "accept-ranges": "bytes",
          // Names the length so a client that asked for the wrong bytes can
          // work out the right ones.
          "content-range": unsatisfiedRange(object.size),
          etag: object.etag,
        },
      });
    }
  }

  const found = await reading("a book", () =>
    storage.read(objectKey, {
      ...(conditional ? { ifNoneMatch: conditional } : {}),
      ...(wanted.kind === "range" ? { range: wanted.range } : {}),
    }),
  );
  if (!found) return new Response("Not found", { status: 404 });

  const { object } = found;
  const headers = new Headers({
    "accept-ranges": "bytes",
    etag: object.etag,
    // The type below is the provider's, and a browser that sniffs past it can
    // arrive at a different answer to the one this route stated.
    "x-content-type-options": "nosniff",
  });

  if (!found.body) {
    // Two ways to have no body. Either the caller already holds this version,
    // or the object changed between the look at its metadata and the read and
    // the range now falls outside it — which is the same answer as above, from
    // a race rather than from a bad request.
    if (
      conditional &&
      normaliseEtag(conditional) === normaliseEtag(object.etag)
    ) {
      return new Response(null, { status: 304, headers });
    }

    headers.set("content-range", unsatisfiedRange(object.size));
    return new Response(null, { status: 416, headers });
  }

  const contentType = object.contentType ?? "application/octet-stream";
  headers.set("content-type", contentType);
  headers.set(
    "content-disposition",
    contentDisposition(target.file, inline && mayInline(contentType)),
  );

  // What the provider says it served, not what was asked for.
  if (found.range) {
    headers.set("content-length", String(found.range.length));
    headers.set("content-range", contentRange(found.range, object.size));
    return new Response(found.body, { status: 206, headers });
  }

  headers.set("content-length", String(object.size));
  return new Response(found.body, { headers });
}
