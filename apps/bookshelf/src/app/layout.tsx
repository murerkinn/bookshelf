import type { Metadata } from "next";
import { OG_BASE, SITE_DESCRIPTION, SITE_NAME, siteOrigin } from "@/lib/site";
import "./globals.css";

/**
 * Everything a shared link needs, resolved against the origin the request
 * arrived at. `metadataBase` is what turns the file-based OG image and every
 * relative URL below it into the absolute ones crawlers insist on.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: await siteOrigin(),
    // The template gives every other page its suffix, so a shared book link
    // reads "Title · Bookshelf" without each page repeating the name.
    title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
    description: SITE_DESCRIPTION,
    applicationName: SITE_NAME,
    openGraph: {
      ...OG_BASE,
      type: "website",
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
      url: "/",
    },
    // No twitter.images and no twitter-image file: Next reuses the Open Graph
    // image for twitter:image, so a second copy would only repeat itself.
    twitter: {
      card: "summary_large_image",
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
    },
  };
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
