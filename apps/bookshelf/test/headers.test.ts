import assert from "node:assert/strict";
import { test } from "node:test";
import { securityHeaders } from "../src/lib/headers.ts";

/**
 * The response headers, which are the one part of the app's behaviour decided
 * by configuration rather than by a handler.
 *
 * Worth pinning because two of the decisions read like oversights. Both are
 * load-bearing, both were arrived at by watching the readers break, and both
 * are the kind of thing a later tidy-up reverts on the way past.
 */

function rules() {
  return securityHeaders();
}

/** The rule whose `source` matches a path, last match winning as Next does. */
function policyFor(path: string): Map<string, string> {
  const found = new Map<string, string>();

  for (const rule of rules()) {
    // The sources here are either `/:path*`, which matches everything, or one
    // negative lookahead. Enough to answer which rule covers a path without
    // reimplementing path-to-regexp.
    const lookahead = rule.source.match(/\(\?!([^)]*)\)/);
    const applies = !lookahead
      ? true
      : !lookahead[1]
          .split("|")
          .some((prefix) => path.startsWith(`/${prefix}`));

    if (applies) {
      for (const { key, value } of rule.headers) found.set(key, value);
    }
  }

  return found;
}

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
}

test("every response says how to treat what it is carrying", () => {
  for (const path of [
    "/",
    "/read/a-book/a-book.epub",
    "/book/a-book/a-book.epub/x.xhtml",
    "/download/a-book/a-book.epub",
  ]) {
    const policy = policyFor(path);
    assert.equal(policy.get("x-content-type-options"), "nosniff", path);
    assert.equal(policy.get("referrer-policy"), "no-referrer", path);
    assert.ok(policy.get("permissions-policy"), path);
  }
});

test("a page refuses to be framed, and the two routes meant to be framed do not", () => {
  const page = policyFor("/read/a-book/a-book.epub");
  assert.equal(page.get("x-frame-options"), "DENY");
  assert.ok(
    directive(page.get("content-security-policy") ?? "", "frame-ancestors"),
  );

  // The EPUB reader renders a chapter into a same-origin iframe, and the
  // fallback for a format with no reader points one at `?inline=1`. Refusing
  // to frame either leaves the reader showing an empty box.
  for (const framed of [
    "/book/a-book/a-book.epub/OEBPS/ch1.xhtml",
    "/download/a-book/a-book.pdf",
  ]) {
    const policy = policyFor(framed);
    assert.equal(policy.get("x-frame-options"), undefined, framed);
    assert.equal(policy.get("content-security-policy"), undefined, framed);
  }
});

/**
 * epub.js renders a chapter by writing it into an iframe's `srcdoc`, which
 * inherits this policy, and it injects a `<base>` into every chapter so the
 * relative URLs inside resolve back to `/book/`. `base-uri 'none'` blocks that
 * element and every EPUB loses its images and stylesheets.
 */
test("a chapter may still carry the base tag epub.js gives it", () => {
  const csp =
    policyFor("/read/a-book/a-book.epub").get("content-security-policy") ?? "";
  assert.equal(directive(csp, "base-uri"), "base-uri 'self'");
});

test("the policy names an origin for everything it allows", () => {
  const csp = policyFor("/").get("content-security-policy") ?? "";

  assert.equal(directive(csp, "default-src"), "default-src 'self'");
  assert.equal(directive(csp, "object-src"), "object-src 'none'");
  assert.equal(directive(csp, "form-action"), "form-action 'self'");

  // pdf.js draws pages from a worker and decodes JPEG 2000 in WebAssembly.
  assert.match(directive(csp, "worker-src") ?? "", /'self'/);
  assert.match(directive(csp, "script-src") ?? "", /'wasm-unsafe-eval'/);

  // No origin outside this one is named anywhere in the policy.
  assert.doesNotMatch(csp, /https?:\/\//);
});

/**
 * A production build served over plain HTTP is a real deployment here — a box
 * on your own network. Upgrading its own subresources to a scheme it is not
 * listening on takes that deployment down.
 */
test("nothing forces a scheme the deployment may not be serving", () => {
  const csp = policyFor("/").get("content-security-policy") ?? "";
  assert.equal(directive(csp, "upgrade-insecure-requests"), undefined);
});
