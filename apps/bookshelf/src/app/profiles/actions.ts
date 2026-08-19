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

/** Reports a failure through the URL, since there is no client state to hold it. */
function fail(message: string): never {
  redirect(`/profiles?error=${encodeURIComponent(message)}`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export async function switchProfile(form: FormData): Promise<void> {
  const id = text(form, "id");
  const { profiles } = await getServices();

  const chosen = (await profiles.list()).find((profile) => profile.id === id);
  if (!chosen) fail("That profile no longer exists.");

  const store = await cookies();
  store.set(PROFILE_COOKIE, chosen.id, await profileCookieOptions());

  revalidatePath("/", "layout");
  redirect("/");
}

export async function createProfile(form: FormData): Promise<void> {
  const { profiles } = await getServices();

  try {
    await profiles.create(text(form, "name"));
  } catch (error) {
    fail(reason(error));
  }

  revalidatePath("/", "layout");
  redirect("/profiles");
}

export async function renameProfile(form: FormData): Promise<void> {
  const { profiles } = await getServices();

  try {
    await profiles.rename(text(form, "id"), text(form, "name"));
  } catch (error) {
    fail(reason(error));
  }

  revalidatePath("/", "layout");
  redirect("/profiles");
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
  redirect("/profiles");
}
