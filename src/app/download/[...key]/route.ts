import { getServices } from "@/services/container";

/** RFC 6266 `filename` + `filename*`, so non-ASCII titles survive the trip. */
function contentDisposition(fileName: string, inline: boolean): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = inline ? "inline" : "attachment";
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(
  request: Request,
  ctx: RouteContext<"/download/[...key]">,
) {
  const { key } = await ctx.params;
  const objectKey = key.join("/");

  // `?inline=1` lets the reader embed a format the browser can display itself,
  // such as a PDF, instead of prompting a download.
  const inline = new URL(request.url).searchParams.has("inline");

  const { storage } = await getServices();
  const found = await storage.read(objectKey);

  if (!found?.body) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(found.body, {
    headers: {
      "content-type": found.object.contentType ?? "application/octet-stream",
      "content-length": String(found.object.size),
      "content-disposition": contentDisposition(
        objectKey.slice(objectKey.lastIndexOf("/") + 1),
        inline,
      ),
      etag: found.object.etag,
    },
  });
}
