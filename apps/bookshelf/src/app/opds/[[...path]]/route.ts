import { serviceUnavailable } from "@/lib/http";
import { serveOpds } from "@/lib/opds/serve";
import { siteOrigin } from "@/lib/origin";
import { enforceR2RateLimit } from "@/lib/rate-limit";
import { getServices } from "@/services/container";
import { reading } from "@/services/errors";

/**
 * The OPDS catalog, at `/opds` and everything under it.
 *
 * One route for the whole protocol. `lib/opds/serve.ts` owns the URL space,
 * because the serializers there already have to generate every one of those
 * URLs to write their links, and a second copy of the space in the filesystem
 * is a second copy that can drift.
 *
 * This handler is the whole of what the protocol needs from Next: where the
 * instance is reached, what the catalog holds, and how to say that the library
 * could not be read. Everything else is a pure function of those three.
 */
export async function GET(
  request: Request,
  ctx: RouteContext<"/opds/[[...path]]">,
) {
  try {
    return await serve(request, ctx);
  } catch (error) {
    // A client told 404 stops asking; one told 503 comes back. The library
    // being unreachable is emphatically the second, and an OPDS client that
    // cached an empty catalog would show an empty library until it refreshed.
    return serviceUnavailable(error);
  }
}

async function serve(request: Request, ctx: RouteContext<"/opds/[[...path]]">) {
  const { path } = await ctx.params;
  const { catalog, limits } = await getServices();

  // Every feed is a view of the catalog, so there is nothing on this route to
  // be later than: the read below is the first thing it does. The catalog's own
  // memo and response cache may well answer it without touching the bucket,
  // which the route cannot see from here — so an OPDS client polling for new
  // books is counted whether or not its poll reached R2.
  const limited = await enforceR2RateLimit(request, limits);
  if (limited) return limited;

  const [origin, shelf] = await Promise.all([
    siteOrigin(),
    reading("the catalog", () => catalog.shelf()),
  ]);

  return serveOpds(shelf, {
    path: path ?? [],
    query: new URL(request.url).searchParams,
    origin,
    accept: request.headers.get("accept"),
    ifNoneMatch: request.headers.get("if-none-match"),
  });
}
