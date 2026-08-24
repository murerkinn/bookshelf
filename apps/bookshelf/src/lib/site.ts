/** What the shelf calls itself, wherever a name is wanted. */
export const SITE_NAME = "Bookshelf";

/** One sentence, shared by the metadata, the manifest and the OG image. */
export const SITE_DESCRIPTION = "Browse, read and download your ebook library.";

/**
 * The Open Graph fields every page shares.
 *
 * Spread into each page's own `openGraph` rather than left to be inherited,
 * because a child's `openGraph` replaces its parent's outright instead of
 * merging into it — anything not repeated goes missing from the tags.
 */
export const OG_BASE = {
  siteName: SITE_NAME,
  locale: "en_US",
} as const;
