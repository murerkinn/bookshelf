import { cookies } from "next/headers";
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

/**
 * The profile the current request belongs to.
 *
 * Memoised for the render, so a page that shows the profile chip and also
 * loads that profile's positions reads the profile list once. Nothing is
 * written here: a library with one profile never needs the cookie at all.
 */
export const activeProfile = cache(async (): Promise<Profile> => {
  const store = await cookies();
  const { profiles } = await getServices();
  return profiles.resolve(store.get(PROFILE_COOKIE)?.value);
});
