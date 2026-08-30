import { describe, expect, it, vi } from "vitest";
import { SafeScheduler } from "../src/scheduler.js";

describe("safe scheduler", () => {
  it("suppresses overlapping runs and reports the overlap", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const task = vi.fn(() => blocked);
    const logger = { warn: vi.fn(), error: vi.fn() };
    const scheduler = new SafeScheduler(logger as any);
    scheduler.every("slow", 5, task);
    await new Promise((resolve) => setTimeout(resolve, 18));
    expect(task).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith("Scheduled task overlap suppressed", { task: "slow" });
    release();
    scheduler.stop();
  });
});
