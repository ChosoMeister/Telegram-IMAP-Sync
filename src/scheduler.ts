import type { Logger } from "./logger.js";
import { describeError } from "./errors.js";

export class SafeScheduler {
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(private readonly logger: Logger) {}

  every(name: string, intervalMs: number, task: () => Promise<void> | void): void {
    const run = async () => {
      if (this.running.has(name)) {
        this.logger.warn("Scheduled task overlap suppressed", { task: name });
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
  }
}
