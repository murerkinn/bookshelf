import Link from "next/link";
import { Avatar } from "@/app/avatar";
import {
  createProfile,
  deleteProfile,
  renameProfile,
  switchProfile,
} from "@/app/profiles/actions";
import { getServices } from "@/services/container";
import { activeProfile } from "@/services/session";

const BUTTON =
  "rounded-lg border border-black/10 px-3 py-1.5 text-sm font-medium transition-colors hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10";
const INPUT =
  "min-w-0 rounded-lg border border-black/10 bg-transparent px-3 py-1.5 text-sm dark:border-white/15";

export default async function ProfilesPage(props: PageProps<"/profiles">) {
  const { error } = await props.searchParams;
  const { profiles } = await getServices();
  const [all, current] = await Promise.all([profiles.list(), activeProfile()]);
  const writable = profiles.writable;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <Link
        href="/"
        className="text-sm font-medium text-zinc-500 hover:text-inherit"
      >
        ← Shelf
      </Link>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Profiles</h1>
      <p className="mt-2 text-zinc-500">
        Everyone reading from this library keeps their own place in each book.
      </p>

      {typeof error === "string" && (
        <p className="mt-6 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {!writable && (
        <p className="mt-6 rounded-lg border border-black/10 px-4 py-3 text-sm text-zinc-500 dark:border-white/15">
          This library is read-only, so profiles cannot be added or changed.
          Reading positions are kept in this browser instead of being shared
          between your devices.
        </p>
      )}

      <ul className="mt-10 divide-y divide-black/10 dark:divide-white/10">
        {all.map((profile) => {
          const active = profile.id === current.id;

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
                      className={`${INPUT} w-full max-w-56`}
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
                <span className="shrink-0 text-sm text-zinc-500">
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
                    className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-500 transition-colors hover:bg-black/5 hover:text-red-600 dark:hover:bg-white/10 dark:hover:text-red-400"
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
            className={`${INPUT} w-full max-w-56`}
          />
          <button type="submit" className={BUTTON}>
            Add profile
          </button>
        </form>
      )}

      {writable && (
        <p className="mt-3 text-sm text-zinc-500">
          Adding a profile starts reading as it.
        </p>
      )}
    </main>
  );
}
