import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedOrigin } from "../src/lib/forwarded.ts";

/**
 * Where a request says it arrived, which is where every absolute link the
 * shelf writes points — OPDS acquisition links above all.
 *
 * The headers are the client's own unless a proxy overwrote them, so what is
 * pinned here is both halves: that a proxy which does say where the shelf is
 * still gets believed, and that a header which is not a scheme or a host never
 * becomes one.
 */

function origin(headers: Record<string, string>): string {
  return forwardedOrigin(new Headers(headers)).href;
}

test("a proxy that says where the shelf is gets believed", () => {
  assert.equal(
    origin({
      host: "app:3000",
      "x-forwarded-host": "shelf.example",
      "x-forwarded-proto": "https",
    }),
    "https://shelf.example/",
  );
  assert.equal(
    origin({ host: "shelf.lan:8080", "x-forwarded-proto": "http, https" }),
    "http://shelf.lan:8080/",
  );
});

test("without a proxy, the host is the request's own", () => {
  assert.equal(origin({ host: "shelf.example" }), "https://shelf.example/");
  assert.equal(origin({ host: "localhost:3000" }), "http://localhost:3000/");
  assert.equal(origin({ host: "[::1]:3000" }), "http://[::1]:3000/");
  assert.equal(origin({}), "http://localhost:3000/");
});

test("a forwarded scheme is http or https, or it is not used", () => {
  for (const proto of ["javascript", "data", "file", "ftp", "https:evil"]) {
    assert.equal(
      origin({ host: "shelf.example", "x-forwarded-proto": proto }),
      "https://shelf.example/",
      proto,
    );
  }
  assert.equal(
    origin({ host: "shelf.example", "x-forwarded-proto": "HTTP" }),
    "http://shelf.example/",
  );
});

test("a forwarded host that is not a host falls back to the request's", () => {
  for (const forged of [
    "attacker.example/path",
    "user@attacker.example",
    "attacker.example?x=",
    "attacker.example#x",
    "attacker example",
    "attacker.example:99999",
    "attacker.example:port",
    "[not-an-address]",
    "",
  ]) {
    assert.equal(
      origin({ host: "shelf.example", "x-forwarded-host": forged }),
      "https://shelf.example/",
      forged,
    );
  }
});

test("a host header that is not a host is not one either", () => {
  assert.equal(
    origin({ host: "shelf.example/../elsewhere" }),
    "http://localhost:3000/",
  );
});
