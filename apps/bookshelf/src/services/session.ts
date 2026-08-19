import { cookies, headers } from "next/headers";
import { cache } from "react";
import { getServices } from "@/services/container";
import type { Profile } from "@/services/profiles";

/**
 * Which profile this browser is reading as.
 *
 * Not a credential — it names a profile, it does not prove anything about who
 * is holding it. Anyone who can reach the library can read as any profile in
 * it, which is the right amount of ceremony for a shelf shared with the people
 * you live with, and the wrong amount for one on the open internet.
 */
export const PROFILE_COOKIE = "bookshelf_profile";

/** A year: long enough that nobody is asked to choose twice. */
export const PROFILE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * How to set the cookie, decided per request rather than per build.
 *
 * `secure` cannot come from NODE_ENV: a production build served over plain
 * HTTP — which is what a box on your own network is — would set a cookie the
 * browser then refuses to store, and switching profiles would appear to do
 * nothing. The failure modes are not symmetric, so this asks whether the
 * request actually arrived over TLS and only then locks the cookie to it.
 */
export async function profileCookieOptions() {
  const store = await headers();
  const forwarded = store.get("x-forwarded-proto")?.split(",")[0].trim();
  const origin = store.get("origin") ?? "";

  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // Cloudflare and every ordinary reverse proxy set the first; a Node server
    // terminating TLS itself sets neither, and the form post's own origin is
    // what is left to go on.
    secure: forwarded === "https" || origin.startsWith("https://"),
    maxAge: PROFILE_COOKIE_MAX_AGE,
  } as const;
}

/**
 * The profile the current request belongs to.
 *
 * Memoised for the render, so a page that shows the profile chip and also
 * loads that profile's positions reads the profile list once. Nothing is
 * written here: a library with one profile never needs the cookie, and it is
 * only set when someone actually switches.
 */
export const activeProfile = cache(async (): Promise<Profile> => {
  const store = await cookies();
  const { profiles } = await getServices();
  return profiles.resolve(store.get(PROFILE_COOKIE)?.value);
});
