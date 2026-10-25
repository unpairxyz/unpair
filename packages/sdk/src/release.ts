/**
 * Release timer for quiet mode.
 *
 * A payout that leaves the shielded pool a fixed time after it landed is a
 * link by timing. A random delay breaks it. The defaults follow Nym's
 * nym-swizzle-zcash: exponential delay with a mean of 144 blocks, capped
 * at 576 blocks (about 3 and 12 hours at 75 second Zcash blocks).
 */

export interface ReleaseTimerConfig {
  /** Mean of the exponential delay, in blocks. Default 144. */
  meanBlocks: number;
  /** Hard cap, in blocks. Default 576. */
  maxBlocks: number;
  /** Floor, in blocks. Default 1. */
  minBlocks: number;
  /** Target block time, in milliseconds. Zcash is 75000. */
  blockTimeMs: number;
}

export const ZCASH_BLOCK_TIME_MS = 75_000;

export const DEFAULT_RELEASE_TIMER: ReleaseTimerConfig = {
  meanBlocks: 144,
  maxBlocks: 576,
  minBlocks: 1,
  blockTimeMs: ZCASH_BLOCK_TIME_MS,
};

/** Returns a number in [0, 1). Must be cryptographically random in production. */
export type Rng = () => number;

export interface ReleaseSchedule {
  delayBlocks: number;
  delayMs: number;
  releaseAt: Date;
}

export class ReleaseTimerError extends Error {
  override readonly name = "ReleaseTimerError";
}

/** Uniform [0, 1) from the platform CSPRNG. */
export const cryptoRng: Rng = () => {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new ReleaseTimerError("no crypto.getRandomValues; pass an rng");
  }
  const buf = new Uint32Array(1);
  c.getRandomValues(buf);
  return (buf[0] as number) / 4_294_967_296;
};

export function assertReleaseTimerConfig(cfg: ReleaseTimerConfig): void {
  const ints: Array<[string, number]> = [
    ["meanBlocks", cfg.meanBlocks],
    ["maxBlocks", cfg.maxBlocks],
    ["minBlocks", cfg.minBlocks],
    ["blockTimeMs", cfg.blockTimeMs],
  ];
  for (const [name, v] of ints) {
    if (!Number.isFinite(v) || v <= 0) throw new ReleaseTimerError(`${name} must be a positive number`);
  }
  if (cfg.minBlocks > cfg.maxBlocks) throw new ReleaseTimerError("minBlocks cannot exceed maxBlocks");
}

/**
 * Sample a delay in whole blocks. Exponential with the configured mean,
 * then clamped to [minBlocks, maxBlocks]. Clamping pulls the realised
 * mean a little under `meanBlocks`; at the defaults it is about 134.
 */
export function sampleReleaseDelayBlocks(cfg: ReleaseTimerConfig = DEFAULT_RELEASE_TIMER, rng: Rng = cryptoRng): number {
  assertReleaseTimerConfig(cfg);
  const u = rng();
  if (!(u >= 0 && u < 1)) throw new ReleaseTimerError(`rng must return a number in [0, 1), got ${u}`);
  const raw = -cfg.meanBlocks * Math.log(1 - u);
  const blocks = Math.max(cfg.minBlocks, Math.min(cfg.maxBlocks, Math.ceil(raw)));
  return blocks;
}

export function blocksToMs(blocks: number, blockTimeMs = ZCASH_BLOCK_TIME_MS): number {
  return Math.round(blocks * blockTimeMs);
}

/** Pick a release time for a payout that landed at `landedAt`. */
export function scheduleRelease(
  landedAt: Date,
  cfg: ReleaseTimerConfig = DEFAULT_RELEASE_TIMER,
  rng: Rng = cryptoRng,
): ReleaseSchedule {
  const delayBlocks = sampleReleaseDelayBlocks(cfg, rng);
  const delayMs = blocksToMs(delayBlocks, cfg.blockTimeMs);
  return { delayBlocks, delayMs, releaseAt: new Date(landedAt.getTime() + delayMs) };
}

/** Plain words for the quote screen. */
export function describeReleaseWindow(cfg: ReleaseTimerConfig = DEFAULT_RELEASE_TIMER): string {
  const hours = (blocks: number) => Math.round((blocks * cfg.blockTimeMs) / 3_600_000);
  return `Quiet mode releases after a random delay. Usually about ${hours(cfg.meanBlocks)} hours, never more than ${hours(cfg.maxBlocks)} hours.`;
}
