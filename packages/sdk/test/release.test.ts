import { describe, expect, it } from "vitest";
import {
  DEFAULT_RELEASE_TIMER,
  ReleaseTimerError,
  blocksToMs,
  cryptoRng,
  describeReleaseWindow,
  sampleReleaseDelayBlocks,
  scheduleRelease,
} from "../src/release.js";

describe("sampleReleaseDelayBlocks", () => {
  it("stays inside [min, max]", () => {
    for (let i = 0; i < 2_000; i++) {
      const b = sampleReleaseDelayBlocks(DEFAULT_RELEASE_TIMER, cryptoRng);
      expect(b).toBeGreaterThanOrEqual(1);
      expect(b).toBeLessThanOrEqual(576);
      expect(Number.isInteger(b)).toBe(true);
    }
  });
  it("clamps at the cap for an rng near 1", () => {
    expect(sampleReleaseDelayBlocks(DEFAULT_RELEASE_TIMER, () => 0.999999)).toBe(576);
  });
  it("floors at min for an rng at 0", () => {
    expect(sampleReleaseDelayBlocks(DEFAULT_RELEASE_TIMER, () => 0)).toBe(1);
  });
  it("has a mean a little under meanBlocks", () => {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += sampleReleaseDelayBlocks(DEFAULT_RELEASE_TIMER, cryptoRng);
    const mean = sum / n;
    expect(mean).toBeGreaterThan(120);
    expect(mean).toBeLessThan(150);
  });
  it("rejects a bad rng", () => {
    expect(() => sampleReleaseDelayBlocks(DEFAULT_RELEASE_TIMER, () => 1)).toThrow(ReleaseTimerError);
  });
});

describe("scheduleRelease", () => {
  it("adds the delay to the landing time", () => {
    const landed = new Date("2026-10-25T00:00:00Z");
    const s = scheduleRelease(landed, DEFAULT_RELEASE_TIMER, () => 0.5);
    expect(s.delayBlocks).toBe(100);
    expect(s.delayMs).toBe(blocksToMs(100));
    expect(s.releaseAt.getTime()).toBe(landed.getTime() + 100 * 75_000);
  });
  it("describes the window in plain words", () => {
    expect(describeReleaseWindow()).toBe(
      "Quiet mode releases after a random delay. Usually about 3 hours, never more than 12 hours.",
    );
  });
});
