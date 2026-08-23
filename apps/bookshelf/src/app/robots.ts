import type { MetadataRoute } from "next";

/**
 * What a crawler is welcome to fetch.
 *
 * The shelf itself is fair game; the routes that serve bytes are not. `/book/`
 * hands out the insides of an archive one chapter at a time and `/download/`
 * whole books, neither of which is a page anyone should arrive on from a search
 * result, and both of which cost a read of object storage to refuse politely.
 *
 * Pages that should stay out of an index say so with a `noindex` of their own
 * instead of being disallowed here, because a crawler has to be able to fetch a
 * page to be told not to index it — and because the social crawlers that build
 * link previews honour this file too. Disallowing `/read/` would take the
 * preview off every shared book, and disallowing `/cover/` the image from it.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/book/", "/download/"],
    },
  };
}
