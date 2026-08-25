import type { RateLimits } from "@/services/ports/limits";

/**
 * Asks one limiter about one visitor. The whole of the binding's contract, in
 * one place, so the two allowances below cannot drift apart.
 *
 * A limiter that throws answers yes. It is there to protect the bucket's quota,
 * and a binding having a bad minute is not a reason to stop serving the
 * library: failing closed would turn one broken dependency into a shelf that
 * answers 429 to everybody for as long as the fault lasts, which is a worse
 * outage than the one being guarded against.
 */
export async function checkRateLimit(
  limiter: RateLimit,
  key: string,
): Promise<boolean> {
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}

/**
 * Cloudflare's rate limiting bindings, one per allowance.
 *
 * Two bindings rather than one counted twice, because they are two questions
 * with two different answers: how much of the bucket a visitor may touch at
 * all, and how many whole books they may carry off. The periods and limits live
 * in wrangler.jsonc, where the deployment can change them without a build.
 */
export class WorkersRateLimits implements RateLimits {
  private readonly r2: RateLimit;
  private readonly download: RateLimit;

  constructor(r2: RateLimit, download: RateLimit) {
    this.r2 = r2;
    this.download = download;
  }

  allowsR2(visitor: string): Promise<boolean> {
    return checkRateLimit(this.r2, visitor);
  }

  allowsDownload(visitor: string): Promise<boolean> {
    return checkRateLimit(this.download, visitor);
  }
}

/**
 * The limiters the Worker was given, or null where it has none.
 *
 * Both or neither: a deployment holding one binding and not the other is a
 * half-configured wrangler.jsonc, and quietly enforcing the half that happens
 * to be bound would hide that rather than leave it visible in the config.
 */
export function workersRateLimits(env: CloudflareEnv): RateLimits | null {
  return env.R2_RATE_LIMITER && env.DOWNLOAD_RATE_LIMITER
    ? new WorkersRateLimits(env.R2_RATE_LIMITER, env.DOWNLOAD_RATE_LIMITER)
    : null;
}
