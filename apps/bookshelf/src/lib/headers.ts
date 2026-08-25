/**
 * What every response carries beyond its body.
 *
 * A module rather than a literal inside `next.config.ts` because two of the
 * decisions here are load-bearing and quietly reversible — the `base-uri` and
 * the two routes held out of the frame directives — and a config file is not
 * somewhere a test can reach.
 */

/**
 * The policy every document carries.
 *
 * The shelf's job is rendering markup somebody else wrote, so the controls that
 * matter are already at the point of contact: `/book/` serves a chapter under
 * `sandbox` with no `allow-scripts`, and the EPUB reader renders one with
 * `allowScriptedContent: false`. This is the layer behind those — it does not
 * decide whether a book's script runs, it decides where anything on this origin
 * may load from, submit to, or be embedded by.
 *
 * `script-src` keeps `'unsafe-inline'` because Next inlines the bootstrap and
 * the RSC payload into every document. Tightening it means a nonce, and a nonce
 * means every page renders dynamically and none of them can be cached — worth
 * doing deliberately, not as a side effect of adding headers. The directives
 * below are the ones that cost nothing and are enforced regardless.
 *
 * Deliberately absent: `upgrade-insecure-requests`. A production build served
 * over plain HTTP is a real deployment here — a box on your own network — and
 * upgrading its own subresources to a scheme it is not listening on would take
 * that deployment down. It is the same asymmetry `profileCookieOptions` weighs
 * when it decides whether to mark the cookie `secure`.
 */
function contentSecurityPolicy(): string {
  // React rebuilds server stacks in the browser with `eval` while developing.
  const dev = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    // `'self'` rather than `'none'`, and epub.js is the reason. It renders a
    // chapter by fetching it and writing the markup into an iframe's `srcdoc`,
    // which inherits this policy — and it injects a `<base>` into every chapter
    // so the relative image, stylesheet and font URLs inside it resolve back to
    // `/book/`. `'none'` blocks that element, and every EPUB loses its
    // pictures. Restricting it to this origin still refuses the attack the
    // directive exists for, which is a `<base>` pointing somewhere else.
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // `wasm-unsafe-eval` is pdf.js, which decodes JPEG 2000 images in
    // WebAssembly and fetches the module only when a document contains one.
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    // Both readers position what they draw with inline styles.
    "style-src 'self' 'unsafe-inline'",
    // A PDF page is drawn to a canvas and its fonts arrive as data URLs.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    // The EPUB reader renders a chapter into a same-origin iframe.
    "frame-src 'self' blob:",
  ].join("; ");
}

/** What is true of every response, whatever it is serving. */
const BASELINE = [
  // The routes that serve bytes state this themselves as well, because a
  // header that only a build step applies is not the same guarantee as one the
  // handler sends.
  { key: "x-content-type-options", value: "nosniff" },
  // A URL here names a book, and what someone reads is nobody else's business.
  { key: "referrer-policy", value: "no-referrer" },
  {
    key: "permissions-policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "microphone=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  },
  { key: "cross-origin-opener-policy", value: "same-origin" },
  { key: "cross-origin-resource-policy", value: "same-origin" },
];

/**
 * The rules, in the order Next applies them: the later match wins a collision.
 */
export function securityHeaders() {
  return [
    { source: "/:path*", headers: BASELINE },
    {
      // Everything but the two routes whose responses are meant to be framed.
      // The EPUB reader renders a chapter from `/book/` into a same-origin
      // iframe, and a format neither reader handles is shown by pointing an
      // iframe at `/download/<key>?inline=1`. Both `frame-ancestors` and
      // `X-Frame-Options` below would refuse those, and the reader would show
      // an empty box instead of a book. Neither loses anything by it: a chapter
      // is already served under `sandbox`, and what guards a download is its
      // disposition and its type, not this.
      source: "/:path((?!book/|download/).*)",
      headers: [
        { key: "content-security-policy", value: contentSecurityPolicy() },
        { key: "x-frame-options", value: "DENY" },
      ],
    },
  ];
}
