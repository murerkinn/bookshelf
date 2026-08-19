"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServices } from "@/services/container";
import {
  activeProfile,
  PROFILE_COOKIE,
  profileCookieOptions,
} from "@/services/session";

/**
 * Server actions rather than route handlers: these are form posts that change
 * state and then need somewhere to send the reader, and they must work with
 * scripting off — the shelf has almost no client JavaScript and profiles
 * should not be the thing that introduces the need for it.
 */

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Where to return to. The switcher lives in the shelf header, so the answer is
 * usually "the page you were already on" — supplied by the form rather than
 * inferred, since a server action has no notion of a referrer it can trust.
 *
 * Checked rather than taken: a path that is not local is an open redirect, and
 * this one arrives in a form field.
 */
function origin(form: FormData): string {
  const from = text(form, "from");
  return from.startsWith("/") && !from.startsWith("//") ? from : "/";
}

/** Reports a failure on the page that can explain it. */
function fail(message: string): never {
  redirect(`/profiles?error=${encodeURIComponent(message)}`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function readAs(id: string): Promise<void> {
  const store = await cookies();
  store.set(PROFILE_COOKIE, id, await profileCookieOptions());
}

export async function switchProfile(form: FormData): Promise<void> {
  const id = text(form, "id");
  const { profiles } = await getServices();

  const chosen = (await profiles.list()).find((profile) => profile.id === id);
  if (!chosen) fail("That profile no longer exists.");

  await readAs(chosen.id);

  revalidatePath("/", "layout");
  redirect(origin(form));
}

/**
 * Creates a profile and reads as it.
 *
 * Always switching is the one rule that holds wherever this is called from: a
 * profile made from the header is you arriving, one made from the manage page
 * is you setting someone up, and switching back is a single click either way.
 * Creating without switching would leave the shelf showing someone else's
 * positions with no sign that anything had happened.
 */
export async function createProfile(form: FormData): Promise<void> {
  const { profiles } = await getServices();

  let created: { id: string };
  try {
    created = await profiles.create(text(form, "name"));
  } catch (error) {
    fail(reason(error));
  }

  await readAs(created.id);

  revalidatePath("/", "layout");
  redirect(origin(form));
}

export async function renameProfile(form: FormData): Promise<void> {
  const { profiles } = await getServices();

  try {
    await profiles.rename(text(form, "id"), text(form, "name"));
  } catch (error) {
    fail(reason(error));
  }

  revalidatePath("/", "layout");
  redirect(origin(form));
}

export async function deleteProfile(form: FormData): Promise<void> {
  const id = text(form, "id");
  const { profiles } = await getServices();
  const current = await activeProfile();

  try {
    await profiles.remove(id);
  } catch (error) {
    fail(reason(error));
  }

  // Deleting the profile you were reading as leaves the cookie pointing at
  // nothing. Clearing it falls back to the first profile rather than leaving
  // the shelf in a state that resolves differently on every request.
  if (current.id === id) {
    const store = await cookies();
    store.delete(PROFILE_COOKIE);
  }

  revalidatePath("/", "layout");
  redirect(origin(form));
}
