/** Runs `work` over `items`, at most `limit` at a time. */
export async function pool(items, limit, work) {
  const queue = [...items];
  const results = [];

  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) {
        results.push(await work(queue.shift()));
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
export async function retry(work, attempts = 3, delayMs = 250) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
