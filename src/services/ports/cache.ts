/**
 * A cache of HTTP responses, keyed by URL.
 *
 * Named to avoid colliding with the global `Cache`, which is one possible
 * implementation rather than the contract. Writes are fire-and-forget: a
 * provider may defer them past the response, and no caller should wait.
 */
export interface ResponseCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): void;
}

/** Used where no cache exists — under `next dev`, or in tests. */
export class NoopCache implements ResponseCache {
  async match(): Promise<Response | undefined> {
    return undefined;
  }

  put(): void {}
}
