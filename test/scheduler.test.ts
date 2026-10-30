import { describe, expect, it, vi } from "vitest";
import { SafeScheduler } from "../src/scheduler.js";

describe("safe scheduler", () => {
  it("suppresses overlapping runs and rate-limits overlap warnings", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(() => blocked);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const scheduler = new SafeScheduler(logger as any);
    scheduler.every("slow", 1_000, task);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(task).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Scheduled task overlap suppressed", { task: "slow" });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(32_000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    release();
    await Promise.resolve();
    scheduler.stop();
    vi.useRealTimers();
  });
});
