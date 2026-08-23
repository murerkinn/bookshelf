import { ChevronLeft, CloudOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/app/avatar";
import {
  createProfile,
  deleteProfile,
  renameProfile,
  switchProfile,
} from "@/app/profiles/actions";
import { State } from "@/app/state";
import { BUTTON, BUTTON_PRIMARY, INPUT } from "@/app/ui";
import { OG_BASE, SITE_DESCRIPTION } from "@/lib/site";
import { getServices } from "@/services/container";
import { ifAvailable } from "@/services/errors";
import type { Profile } from "@/services/profiles";
import { activeProfile } from "@/services/session";

/** Someone's household, which is nobody else's business to index. */
export const metadata: Metadata = {
  title: "Profiles",
  robots: { index: false, follow: false },
  openGraph: { ...OG_BASE, title: "Profiles", url: "/profiles" },
  // Repeated rather than inherited, for the same reason as openGraph above.
  twitter: {
    card: "summary",
    title: "Profiles",
    description: SITE_DESCRIPTION,
  },
};

export default async function ProfilesPage(props: PageProps<"/profiles">) {
  const { error } = await props.searchParams;
  const { profiles } = await getServices();

  // This page is the profile list, so unlike the shelf there is nothing to show
  // without it — but "unreachable" is still a better answer than a 500, and it
  // is the truthful one.
  const household = await ifAvailable(async () => {
    const [all, current] = await Promise.all([
      profiles.list(),
      activeProfile(),
    ]);
    return { all, current };
  });
  const writable = profiles.writable;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <Link
        href="/"
        className="inline-flex items-center gap-0.5 text-sm font-medium text-secondary transition-colors hover:text-foreground"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Shelf
      </Link>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Profiles</h1>
      <p className="mt-2 text-secondary">
        Everyone reading from this library keeps their own place in each book.
      </p>

      {!household ? (
        <div className="mt-20">
          <State
            icon={CloudOff}
            title="The library is unreachable"
            actions={
              <a href="/profiles" className={BUTTON_PRIMARY}>
                Try again
              </a>
            }
          >
            <p>
              Profiles are kept in the library itself, which cannot be read at
              the moment. Nobody has been removed and nothing has been changed.
            </p>
          </State>
        </div>
      ) : (
        <Household
          all={household.all}
          currentId={household.current.id}
          writable={writable}
          error={typeof error === "string" ? error : undefined}
        />
      )}
    </main>
  );
}

function Household({
  all,
  currentId,
  writable,
  error,
}: {
  all: Profile[];
  currentId: string;
  writable: boolean;
  error?: string;
}) {
  return (
    <>
      {error && (
        <p className="mt-6 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {!writable && (
        <p className="mt-6 rounded-xl bg-fill px-4 py-3 text-sm text-secondary">
          This library is read-only, so profiles cannot be added or changed.
          Reading positions are kept in this browser instead of being shared
          between your devices.
        </p>
      )}

      <ul className="mt-10 divide-y divide-separator">
        {all.map((profile) => {
          const active = profile.id === currentId;

          return (
            <li
              key={profile.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4"
            >
              <Avatar name={profile.name} />

              <div className="min-w-0 flex-1">
                {writable ? (
                  <form action={renameProfile} className="flex gap-2">
                    <input type="hidden" name="id" value={profile.id} />
                    <input type="hidden" name="from" value="/profiles" />
                    <input
                      name="name"
                      defaultValue={profile.name}
                      aria-label={`Name for ${profile.name}`}
                      maxLength={40}
                      className={`${INPUT} w-full max-w-56 min-w-0`}
                    />
                    <button type="submit" className={BUTTON}>
                      Save
                    </button>
                  </form>
                ) : (
                  <p className="truncate font-medium">{profile.name}</p>
                )}
              </div>

              {active ? (
                <span className="shrink-0 text-sm text-secondary">
                  Reading as this
                </span>
              ) : (
                <form action={switchProfile} className="shrink-0">
                  <input type="hidden" name="id" value={profile.id} />
                  <input type="hidden" name="from" value="/profiles" />
                  <button type="submit" className={BUTTON}>
                    Switch
                  </button>
                </form>
              )}

              {writable && all.length > 1 && (
                <form action={deleteProfile} className="shrink-0">
                  <input type="hidden" name="id" value={profile.id} />
                  <input type="hidden" name="from" value="/profiles" />
                  <button
                    type="submit"
                    className="rounded-full px-3 py-1.5 text-sm font-medium text-secondary transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                  >
                    Delete
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      {writable && (
        <form action={createProfile} className="mt-8 flex gap-2">
          <input type="hidden" name="from" value="/profiles" />
          <input
            name="name"
            placeholder="Add someone"
            aria-label="New profile name"
            maxLength={40}
            required
            className={`${INPUT} w-full max-w-56 min-w-0`}
          />
          <button type="submit" className={BUTTON}>
            Add profile
          </button>
        </form>
      )}

      {writable && (
        <p className="mt-3 text-sm text-secondary">
          Adding a profile starts reading as it.
        </p>
      )}
    </>
  );
}
