"use client";

import { Check, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { Avatar } from "@/app/avatar";
import { createProfile, switchProfile } from "@/app/profiles/actions";
import { BUTTON, INPUT } from "@/app/ui";
import type { Profile } from "@/services/profiles";

/**
 * Who is reading, and how to become someone else.
 *
 * Built on `<details>` so the whole thing works with scripting off: switching
 * and creating are form posts to server actions, and the panel opens because
 * the browser opens it. The client half only adds what a disclosure widget
 * cannot do on its own — closing on Escape, or on a click elsewhere.
 */
export function ProfileMenu({
  profiles,
  activeId,
  writable,
  from,
}: {
  profiles: Profile[];
  activeId: string;
  /** False against a library the app cannot write to: switching only. */
  writable: boolean;
  /** Where the actions should return to — the page this is rendered on. */
  from: string;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const active = profiles.find((profile) => profile.id === activeId);

  useEffect(() => {
    const element = details.current;
    if (!element) return;

    function dismiss(event: Event) {
      if (element && !element.contains(event.target as Node)) {
        element.open = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && element) element.open = false;
    }

    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <details ref={details} className="relative shrink-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full py-1 pr-2.5 pl-1 transition-colors hover:bg-fill [&::-webkit-details-marker]:hidden">
        <Avatar name={active?.name ?? "?"} size={28} />
        <span className="max-w-32 truncate text-sm font-medium">
          {active?.name}
        </span>
        <ChevronDown aria-hidden="true" className="size-3.5 text-tertiary" />
        <span className="sr-only">Change profile</span>
      </summary>

      <div className="absolute right-0 z-10 mt-2 w-64 rounded-2xl border border-separator bg-surface p-1.5">
        <ul>
          {profiles.map((profile) => (
            <li key={profile.id}>
              <form action={switchProfile}>
                <input type="hidden" name="id" value={profile.id} />
                <input type="hidden" name="from" value={from} />
                <button
                  type="submit"
                  disabled={profile.id === activeId}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fill disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <Avatar name={profile.name} size={24} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {profile.name}
                  </span>
                  {profile.id === activeId && (
                    <>
                      <Check
                        aria-hidden="true"
                        className="size-4 text-accent"
                      />
                      <span className="sr-only">Reading as this</span>
                    </>
                  )}
                </button>
              </form>
            </li>
          ))}
        </ul>

        {writable && (
          <form
            action={createProfile}
            className="mt-1.5 flex gap-1.5 border-t border-separator pt-2"
          >
            <input type="hidden" name="from" value={from} />
            <input
              name="name"
              placeholder="New profile"
              aria-label="New profile name"
              maxLength={40}
              required
              className={`${INPUT} min-w-0 flex-1`}
            />
            <button type="submit" className={`${BUTTON} shrink-0`}>
              Add
            </button>
          </form>
        )}

        <Link
          href="/profiles"
          className="mt-1 block rounded-lg px-2 py-1.5 text-sm text-secondary transition-colors hover:bg-fill hover:text-foreground"
        >
          Manage profiles
        </Link>
      </div>
    </details>
  );
}
