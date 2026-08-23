/** Runs `work` over `items`, at most `limit` at a time. */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];

  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) {
        // Guarded by the loop, but the compiler cannot see that a shift after a
        // length check always yields an item.
        const item = queue.shift() as T;
        results.push(await work(item));
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/**
 * Retries transient failures with a widening delay.
 *
 * Uploads run in parallel, and providers serialise writes in ways that surface
 * as contention rather than as a permanent error — the local miniflare bucket
 * locks its state file, for one. Retrying absorbs that; a genuine failure still
 * ends up thrown after the last attempt.
 */
export async function retry<T>(
  work: () => Promise<T>,
  attempts = 3,
  delayMs = 250,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/** The message an unknown thrown value carries, for reporting it. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `code` a Node system error carries, where there is one. */
export function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
