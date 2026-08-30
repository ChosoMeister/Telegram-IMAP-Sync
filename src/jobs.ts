import type { AiService } from "./ai.js";
import { describeError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { TelegramApi } from "./telegram/api.js";

export class DurableJobWorker {
  private running = false;

  constructor(
    private store: Store, private ai: AiService, private telegram: TelegramApi, private logger: Logger,
    private onAnalysis: (mailId: number) => Promise<void>
  ) {}

  async process(limit = 3): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let processed = 0; processed < limit; processed++) {
        const job = this.store.leaseJob();
        if (!job) break;
        try {
          const mail = this.store.getMail(job.mailId);
          if (!mail) { this.store.completeJob(job.id); continue; }
          if (job.kind === "telegram_cleanup") {
            if (mail.telegramMessageIds.length) await this.telegram.deleteMessages(mail.telegramMessageIds);
            this.store.setTelegramMessages(mail.id, []);
          } else if (job.kind === "analyze") {
            if ((mail.analysis && mail.analysis.provider !== "unavailable") || mail.state === "done" || mail.state === "external_done") {
              this.store.completeJob(job.id); continue;
            }
            const analysis = await this.ai.analyze(mail);
            if (!analysis) throw new Error("All AI providers failed");
            this.store.setAnalysis(mail.id, analysis);
            await this.onAnalysis(mail.id);
          } else throw new Error(`Unsupported job kind: ${job.kind}`);
          this.store.completeJob(job.id);
        } catch (error) { await this.fail(job, error); }
      }
    } finally { this.running = false; }
  }

  private async fail(job: { id: number; kind: string; mailId: number; attempts: number }, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = job.attempts >= 5;
    const retryMs = Math.min(60_000 * (2 ** Math.max(0, job.attempts - 1)), 3_600_000);
    if (terminal && job.kind === "analyze") {
      const mail = this.store.getMail(job.mailId);
      if (mail) {
        this.store.setAnalysis(mail.id, {
          importance: "normal", score: 0,
          summaryFa: "تحلیل هوشمند این ایمیل پس از چند تلاش ناموفق بود.",
          suggestedAction: "متن ایمیل را بررسی کنید یا دکمه «تلاش مجدد تحلیل» را بزنید.",
          reason: message, provider: "unavailable", actionOwner: "unknown"
        });
        await this.onAnalysis(mail.id).catch((renderError) =>
          this.logger.warn("Could not render AI-unavailable state", { mailId: mail.id, error: describeError(renderError) })
        );
      }
    }
    this.store.failJob(job.id, message, retryMs, terminal);
    this.logger.warn("Durable job failed", { jobId: job.id, kind: job.kind, mailId: job.mailId, attempts: job.attempts, terminal, error: message });
  }
}
