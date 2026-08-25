/**
 * How much of the bucket one visitor may reach for.
 *
 * A port rather than the binding itself, for the same reason the response cache
 * is one: the app is deployed to runtimes that have no such thing. A library on
 * a filesystem is not exposed to the internet and has no quota worth
 * protecting, and `next dev` runs in Node with no binding at all — both get
 * {@link NoLimits} and never notice.
 *
 * Asking counts, whatever the answer. That is the point of it: what is being
 * limited is R2 access *attempted*, so a request that goes on to fail, to be
 * abandoned halfway, or to race a dozen of its own siblings has still spent its
 * share of the allowance.
 */
export interface RateLimits {
  /** Whether this visitor may attempt one more operation against the bucket. */
  allowsR2(visitor: string): Promise<boolean>;

  /**
   * Whether they may also take a whole file. Asked in addition to
   * {@link RateLimits.allowsR2} and never instead of it, because a download is
   * a bucket read like any other — just a far more expensive one.
   */
  allowsDownload(visitor: string): Promise<boolean>;
}

/**
 * Used where the runtime has no limiter: the filesystem provider, `next dev`,
 * and the tests. Says yes, so every caller downstream is written once.
 */
export class NoLimits implements RateLimits {
  async allowsR2(): Promise<boolean> {
    return true;
  }

  async allowsDownload(): Promise<boolean> {
    return true;
  }
}
