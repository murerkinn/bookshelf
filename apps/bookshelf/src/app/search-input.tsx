"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

const DEBOUNCE_MS = 300;

/**
 * Keeps the `q` query parameter in step with what's typed, so filtering stays
 * on the server while feeling live. Falls back to a plain GET form submit when
 * JavaScript hasn't loaded.
 */
export function SearchInput({ query }: { query: string }) {
  const router = useRouter();
  const [value, setValue] = useState(query);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    // `query` reflects the URL that is currently rendered, so matching it means
    // there is nothing to push — including on first mount.
    if (value === query) return;

    const timer = setTimeout(() => {
      const trimmed = value.trim();
      startTransition(() => {
        router.replace(trimmed ? `/?q=${encodeURIComponent(trimmed)}` : "/", {
          scroll: false,
        });
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, query, router]);

  return (
    <search className="mt-8 block">
      <form onSubmit={(event) => event.preventDefault()}>
        <div className="relative">
          <input
            type="search"
            name="q"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search books…"
            aria-label="Search books"
            autoComplete="off"
            className="w-full rounded-lg border border-black/10 bg-white px-4 py-2.5 outline-none placeholder:text-zinc-400 focus:border-zinc-400 dark:border-white/15 dark:bg-white/5 dark:focus:border-zinc-500"
          />
          <output
            className={`pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm text-zinc-400 transition-opacity ${
              isPending ? "opacity-100" : "opacity-0"
            }`}
          >
            Searching…
          </output>
        </div>
      </form>
    </search>
  );
}
