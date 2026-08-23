import {
  contentRange,
  ifRangeMatches,
  normaliseEtag,
  parseByteRange,
  unsatisfiedRange,
} from "@bookshelf/core";
import { getServices } from "@/services/container";

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
  const { key } = await ctx.params;
  const objectKey = key.join("/");

  // `?inline=1` lets the reader embed a format the browser can display itself,
  // such as a PDF, instead of prompting a download.
  const inline = new URL(request.url).searchParams.has("inline");
  const conditional = request.headers.get("if-none-match");
  const requestedRange = request.headers.get("range");

  const { storage } = await getServices();

  // A range has to be resolved against the object's length — `bytes=-1024` and
  // an open-ended `bytes=1024-` both need it — so a ranged request costs a look
  // at the metadata first. A plain download does not, and does not pay for it.
  let wanted: ReturnType<typeof parseByteRange> = { kind: "whole" };
  if (requestedRange) {
    const object = await storage.head(objectKey);
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

  const found = await storage.read(objectKey, {
    ...(conditional ? { ifNoneMatch: conditional } : {}),
    ...(wanted.kind === "range" ? { range: wanted.range } : {}),
  });
  if (!found) return new Response("Not found", { status: 404 });

  const { object } = found;
  const headers = new Headers({
    "accept-ranges": "bytes",
    etag: object.etag,
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

  headers.set("content-type", object.contentType ?? "application/octet-stream");
  headers.set(
    "content-disposition",
    contentDisposition(objectKey.slice(objectKey.lastIndexOf("/") + 1), inline),
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
