"use client";

import { LoaderCircle, Search } from "lucide-react";
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
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3.5 my-auto size-4 text-tertiary"
          />
          <input
            type="search"
            name="q"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Search books…"
            aria-label="Search books"
            autoComplete="off"
            className="w-full rounded-xl bg-fill py-2.5 pr-10 pl-10 outline-none transition-shadow placeholder:text-tertiary focus:ring-2 focus:ring-accent"
          />
          <output
            className={`pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-tertiary transition-opacity ${
              isPending ? "opacity-100" : "opacity-0"
            }`}
          >
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            <span className="sr-only">Searching…</span>
          </output>
        </div>
      </form>
    </search>
  );
}
