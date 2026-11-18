import { registerHooks } from "node:module";

/**
 * `next/headers`, for a route handler called outside Next.
 *
 * The real `cookies()` and `headers()` read a request scope that only Next's
 * own server sets up, and throw anywhere else — so a route that asks which
 * profile it is serving cannot be called from a test as it stands. This module
 * stands in for the real one: importing it registers a resolver that answers
 * `next/headers` with this file, and {@link handle} decides which request the
 * two functions describe.
 *
 * Import it before the route, and import the route dynamically. Static imports
 * are all resolved before any module runs, so a route imported alongside this
 * would already have been handed the real `next/headers`.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/headers") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

let current: Request | null = null;

function request(): Request {
  if (!current) throw new Error("next/headers was read outside a request");
  return current;
}

export async function headers(): Promise<Headers> {
  return request().headers;
}

export async function cookies() {
  const jar = new Map<string, string>();
  for (const pair of request().headers.get("cookie")?.split(";") ?? []) {
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }

  return {
    get(name: string) {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
  };
}

/** Calls a route handler as Next would, with this request in scope. */
export async function handle(
  route: (request: Request) => Promise<Response>,
  incoming: Request,
): Promise<Response> {
  current = incoming;
  try {
    return await route(incoming);
  } finally {
    current = null;
  }
}
