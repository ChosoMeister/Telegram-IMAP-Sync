import type { Logger } from "./logger.js";
import { describeError } from "./errors.js";

export class SafeScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();
  private readonly lastOverlapWarningAt = new Map<string, number>();
  private static readonly overlapWarningIntervalMs = 60_000;

  constructor(private readonly logger: Logger) {}

  every(name: string, intervalMs: number, task: () => Promise<void> | void): void {
    const run = async () => {
      if (this.running.has(name)) {
        const now = Date.now();
        const lastWarningAt = this.lastOverlapWarningAt.get(name) ?? 0;
        if (now - lastWarningAt >= SafeScheduler.overlapWarningIntervalMs) {
          this.lastOverlapWarningAt.set(name, now);
          this.logger.warn("Scheduled task overlap suppressed", { task: name });
        }
        return;
      }
      this.running.add(name);
      const startedAt = Date.now();
      try { await task(); }
      catch (error) { this.logger.error("Scheduled task failed", { task: name, durationMs: Date.now() - startedAt, error: describeError(error) }); }
      finally { this.running.delete(name); }
    };
    const timer = setInterval(() => void run(), intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.lastOverlapWarningAt.clear();
  }
}
