import type { AppConfig } from "./config.js";
import type { StoredMail } from "./domain/types.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { AiService } from "./ai.js";
import { buildReply } from "./ai.js";
import type { ImapService } from "./mail/imap.js";
import type { SmtpService } from "./mail/smtp.js";
import type { TelegramApi, TelegramMessage, TelegramUpdate } from "./telegram/api.js";
import { esc } from "./telegram/api.js";
import { mailButtons, renderMail } from "./telegram/render.js";
import { splitTelegramText } from "./mail/content.js";
import { canExtractAttachment, extractAttachmentText } from "./mail/extract.js";
import type { MailRuleService } from "./rules.js";
import { randomUUID } from "node:crypto";

export class MailBotApp {
  private syncRunning = false;
  private stopping = false;
  private imapSupervisorRunning = false;
  private lastSuccessfulSync?: Date;
  private lastTelegramPoll?: Date;
  private inboxCount = 0;
  private jobWorkerRunning = false;
  constructor(
    private config: AppConfig, private store: Store, private imap: ImapService,
    private smtp: SmtpService, private telegram: TelegramApi, private ai: AiService, private logger: Logger,
    private rules?: MailRuleService
  ) {}

  async start(): Promise<void> {
    await this.imap.connect();
    await this.imap.ensureMailboxes(this.rules?.destinations() ?? []);
    void this.smtp.verify().catch((error) => this.logger.warn("SMTP verification failed; inbound mail remains available", {
      error: error instanceof Error ? error.message : String(error)
    }));
    await this.syncInbox(this.config.TELEGRAM_INITIAL_IMPORT_SILENT);
    void this.pollTelegram();
    void this.superviseImap();
    setInterval(() => void this.syncInbox(false), this.config.IMAP_RECONCILE_SECONDS * 1000).unref();
    setInterval(() => void this.rotatePending(), 60 * 60 * 1000).unref();
    setInterval(() => void this.processJobs(), 2_000).unref();
    const purge = () => {
      const removed = this.store.purgeCompleted(this.config.DATA_RETENTION_DAYS);
      if (removed) this.logger.info("Expired completed local records purged", { removed, retentionDays: this.config.DATA_RETENTION_DAYS });
    };
    purge();
    setInterval(purge, 24 * 60 * 60 * 1000).unref();
  }

  async stop(): Promise<void> { this.stopping = true; await this.imap.stop(); }

  isHealthy(): boolean {
    const syncFresh = Boolean(this.lastSuccessfulSync && Date.now() - this.lastSuccessfulSync.getTime() < Math.max(this.config.IMAP_RECONCILE_SECONDS * 3_000, 120_000));
    return !this.stopping && this.imap.isConnected() && syncFresh;
  }

  status(): Record<string, unknown> {
    return {
      ok: this.isHealthy(), imapConnected: this.imap.isConnected(), syncRunning: this.syncRunning,
      lastSuccessfulSync: this.lastSuccessfulSync?.toISOString(), lastTelegramPoll: this.lastTelegramPoll?.toISOString(),
      inboxCount: this.inboxCount, jobs: this.store.jobCounts(), ai: this.ai.status(), smtp: this.smtp.status(), telegram: this.telegram.status(),
      backup: { lastSuccess: this.store.getKv("backup:last-success"), lastError: this.store.getKv("backup:last-error") }, ...this.store.counts()
    };
  }

  private async superviseImap(): Promise<void> {
    if (this.imapSupervisorRunning) return;
    this.imapSupervisorRunning = true;
    let retryMs = 1000;
    try {
      while (!this.stopping) {
        try {
          if (!this.imap.isConnected()) {
            await this.imap.connect();
            await this.imap.ensureMailboxes(this.rules?.destinations() ?? []);
            this.logger.info("IMAP connection restored");
            await this.syncInbox(false);
          }
          retryMs = 1000;
          await this.imap.waitForChanges(() => this.syncInbox(false));
          if (!this.stopping) throw new Error("IMAP connection closed");
        } catch (error) {
          if (this.stopping) break;
          this.logger.warn("IMAP disconnected; reconnect scheduled", {
            retryMs,
            error: error instanceof Error ? error.message : String(error)
          });
          await new Promise((resolve) => setTimeout(resolve, retryMs));
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      }
    } finally { this.imapSupervisorRunning = false; }
  }

  async syncInbox(silent: boolean): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      const newMail: StoredMail[] = [];
      const mailbox = this.imap.mailboxIdentity();
      const knownUids = this.store.listKnownUids(mailbox.path, mailbox.uidValidity);
      for (const incoming of await this.imap.scanInbox(knownUids)) {
        const result = this.store.upsertMail(incoming);
        const rule = this.rules?.match(incoming);
        const ruleAppliedKey = rule ? `mail-rule:${result.id}:${rule.name}` : undefined;
        if (rule && (!rule.actions.copyTo || this.store.getKv(ruleAppliedKey!) !== "applied")) {
          const mail = this.store.getMail(result.id)!;
          try {
            await this.imap.applyRule(mail, rule);
            if (ruleAppliedKey) this.store.setKv(ruleAppliedKey, "applied");
            this.logger.info("Mail rule applied", { mailId: mail.id, rule: rule.name, destination: rule.actions.moveTo ?? rule.actions.copyTo ?? "flags-only" });
            if (rule.actions.moveTo) {
              if (mail.telegramMessageIds.length) await this.telegram.deleteMessages(mail.telegramMessageIds).catch(() => false);
              this.store.setTelegramMessages(mail.id, []);
              this.store.setState(mail.id, "done");
              continue;
            }
          } catch (error) {
            this.logger.warn("Mail rule failed; keeping message actionable", { mailId: mail.id, rule: rule.name, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!result.created) {
          const existing = this.store.getMail(result.id)!;
          if (!existing.telegramMessageIds.length) await this.publish(existing, silent);
          else await this.enrichTelegram(existing);
          continue;
        }
        const mail = this.store.getMail(result.id)!;
        await this.publish(mail, silent);
        newMail.push(mail);
      }
      const liveUids = await this.imap.listInboxUids();
      this.inboxCount = liveUids.size;
      await this.reconcileRemovedMail(mailbox.path, mailbox.uidValidity, liveUids);
      await this.cleanupNonActionableCards();
      for (const mail of this.store.listPending().filter((item) => !item.telegramMessageIds.length)) {
        await this.publish(mail, silent);
        this.logger.info("Recovered missing Telegram card from local state", { mailId: mail.id });
      }
      const analysisTargets = this.store.listPending().filter((mail) => !mail.analysis);
      for (const mail of analysisTargets) this.store.enqueueJob("analyze", mail.id);
      void this.processJobs();
      this.lastSuccessfulSync = new Date();
    } catch (error) {
      this.logger.error("Inbox reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
    } finally { this.syncRunning = false; }
  }

  private async processJobs(): Promise<void> {
    if (this.jobWorkerRunning || this.stopping) return;
    this.jobWorkerRunning = true;
    try {
      for (let processed = 0; processed < 3; processed++) {
        const job = this.store.leaseJob();
        if (!job) break;
        try {
          const mail = this.store.getMail(job.mailId);
          if (!mail || mail.analysis || mail.state === "done" || mail.state === "external_done") {
            this.store.completeJob(job.id); continue;
          }
          if (job.kind !== "analyze") throw new Error(`Unsupported job kind: ${job.kind}`);
          const analysis = await this.ai.analyze(mail);
          if (!analysis) throw new Error("All AI providers failed");
          this.store.setAnalysis(mail.id, analysis);
          await this.enrichTelegram(this.store.getMail(mail.id)!);
          this.store.completeJob(job.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const terminal = job.attempts >= 5;
          this.store.failJob(job.id, message, Math.min(60_000 * (2 ** Math.max(0, job.attempts - 1)), 3_600_000), terminal);
          this.logger.warn("Durable job failed", { jobId: job.id, kind: job.kind, mailId: job.mailId, attempts: job.attempts, terminal, error: message });
        }
      }
    } finally { this.jobWorkerRunning = false; }
  }

  private async reconcileRemovedMail(mailbox: string, uidValidity: string, liveUids: ReadonlySet<number>): Promise<void> {
    for (const mail of this.store.listActionable(mailbox, uidValidity)) {
      const key = `missing-inbox:${mail.id}`;
      if (liveUids.has(mail.uid)) { this.store.deleteKv(key); continue; }
      const misses = Number(this.store.getKv(key) ?? 0) + 1;
      if (misses < 2) { this.store.setKv(key, String(misses)); continue; }
      if (mail.telegramMessageIds.length) {
        await this.telegram.deleteMessages(mail.telegramMessageIds).catch((error) =>
          this.logger.warn("Could not delete externally completed Telegram card", { mailId: mail.id, error: String(error) })
        );
      }
      this.store.setTelegramMessages(mail.id, []);
      this.store.setState(mail.id, "external_done");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.store.deleteKv(key);
      this.logger.info("Mail removed from Telegram after external Inbox move", { mailId: mail.id, uid: mail.uid });
    }
  }

  private async cleanupNonActionableCards(): Promise<void> {
    for (const mail of this.store.listNonActionableWithTelegram()) {
      await this.telegram.deleteMessages(mail.telegramMessageIds).catch((error) =>
        this.logger.warn("Could not clean stale Telegram card", { mailId: mail.id, error: String(error) })
      );
      this.store.setTelegramMessages(mail.id, []);
    }
  }

  private async publish(mail: StoredMail, silent: boolean): Promise<void> {
    const sent = await this.telegram.sendMessage(renderMail(mail), mailButtons(mail), silent);
    this.store.setTelegramMessages(mail.id, [sent.message_id]);
  }

  private async enrichTelegram(mail: StoredMail): Promise<void> {
    const primaryId = mail.telegramMessageIds[0];
    if (!primaryId) return;
    await this.telegram.editMessage(primaryId, renderMail(mail), mailButtons(mail)).catch((error) =>
      this.logger.warn("Telegram enrichment edit failed", { mailId: mail.id, error: String(error) })
    );
  }

  private async rotatePending(): Promise<void> {
    const cutoff = Date.now() - this.config.TELEGRAM_REFRESH_HOURS * 3_600_000;
    const pending = this.store.listPending();
    if (!pending.some((m) => m.telegramCreatedAt && m.telegramCreatedAt.getTime() < cutoff)) return;
    for (const mail of pending) {
      const oldIds = [...mail.telegramMessageIds];
      const sent = await this.telegram.sendMessage(renderMail(mail), mailButtons(mail), true);
      this.store.setTelegramMessages(mail.id, [sent.message_id, ...oldIds]);
      if (oldIds.length) await this.telegram.deleteMessages(oldIds).catch(() => false);
      this.store.setTelegramMessages(mail.id, [sent.message_id]);
    }
    this.logger.info("Pending Telegram queue rotated", { count: pending.length });
  }

  private async pollTelegram(): Promise<void> {
    let offset = Number(this.store.getKv("telegram_offset") ?? 0);
    while (!this.stopping) {
      try {
        const updates = await this.telegram.getUpdates(offset);
        this.lastTelegramPoll = new Date();
        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          try {
            await this.handleUpdate(update);
          } catch (error) {
            this.logger.error("Telegram update handling failed", {
              updateId: update.update_id,
              error: error instanceof Error ? error.message : String(error)
            });
          } finally {
            this.store.setKv("telegram_offset", String(offset));
          }
        }
      } catch (error) {
        this.logger.warn("Telegram polling failed", { error: error instanceof Error ? error.message : String(error) });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const userId = update.callback_query?.from.id ?? update.message?.from?.id;
    if (userId !== this.config.TELEGRAM_USER_ID) return;
    if (update.callback_query?.data) await this.handleCallback(update.callback_query.id, update.callback_query.data);
    else if (update.message?.text) await this.handleText(update.message);
  }

  private async handleCallback(callbackId: string, data: string): Promise<void> {
    const match = /^m:(\d+):(summary|body(?::\d+)?|files|hidden|thread|ask|askmail|askfiles|askthread|done|reply|replyall|forward|instruct|edit|formal|short|friendly|send|cancel)$/.exec(data);
    if (!match) return;
    const mail = this.store.getMail(Number(match[1]));
    if (!mail) { await this.answerCallback(callbackId, "ایمیل پیدا نشد"); return; }
    if (match[2] === "done" && mail.state === "done") {
      await this.answerCallback(callbackId, "این ایمیل قبلاً انجام شده است");
      if (mail.telegramMessageIds.length) {
        await this.telegram.deleteMessages(mail.telegramMessageIds).catch(() => false);
        this.store.setTelegramMessages(mail.id, []);
      }
      return;
    }
    if (match[2] === "done" && mail.state === "processing") {
      await this.answerCallback(callbackId, "عملیات در حال انجام است");
      return;
    }
    await this.answerCallback(callbackId);
    const action = match[2];
    this.logger.info("Telegram action received", { mailId: mail.id, action });
    if (action === "summary") return this.showSummary(mail);
    if (action?.startsWith("body")) return this.showBody(mail, Number(action.split(":")[1] ?? 0));
    if (action === "files") return this.showFiles(mail);
    if (action === "hidden") return this.showHiddenFiles(mail);
    if (action === "thread") return this.showThread(mail);
    if (action === "ask") return this.chooseAiContext(mail);
    if (action === "askmail" || action === "askfiles" || action === "askthread") return this.startAiQuestion(mail, action === "askthread" ? "thread" : action === "askfiles" ? "attachments" : "mail");
    if (action === "done") return this.done(mail);
    if (action === "reply" || action === "replyall") return this.startReply(mail, action === "replyall");
    if (action === "forward") return this.startForward(mail);
    if (action === "instruct" || action === "edit") {
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, action === "edit" ? "manual_edit" : "instruction", current?.replyAll ?? false, current?.tone ?? "formal", current?.draft, current?.metadata);
      const isForward = current?.metadata?.kind === "forward";
      const prompt = await this.telegram.sendMessage(action === "edit"
        ? `متن نهایی ${isForward ? "همراه فوروارد" : "پاسخ"} را دقیقاً همان‌طور که باید ارسال شود بنویسید:`
        : `بگویید متن همراه ${isForward ? "فوروارد" : "پاسخ"} چه چیزی را بیان کند؛ AI آن را با متن ایمیل و لحن انتخابی ترکیب می‌کند:`, undefined, false, true);
      this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
      return;
    }
    if (action === "formal" || action === "short" || action === "friendly") return this.changeTone(mail, action);
    if (action === "send") {
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
      return current?.metadata?.kind === "forward" ? this.sendForward(mail) : this.sendReply(mail);
    }
    this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
    await this.showSummary(mail);
  }

  private async answerCallback(callbackId: string, text?: string): Promise<void> {
    try { await this.telegram.answerCallbackQuery(callbackId, text); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/query is too old|query ID is invalid/i.test(message)) {
        this.logger.debug("Ignoring expired Telegram callback acknowledgement", { callbackId });
        return;
      }
      throw error;
    }
  }

  private async showBody(mail: StoredMail, requestedPage = 0): Promise<void> {
    const chunks = splitTelegramText(mail.text || "متن قابل استخراج نیست.");
    const page = Math.max(0, Math.min(requestedPage, chunks.length - 1));
    const navigation = [];
    if (page > 0) navigation.push({ text: "⬅️ قبلی", callback_data: `m:${mail.id}:body:${page - 1}` });
    navigation.push({ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" as const });
    if (page < chunks.length - 1) navigation.push({ text: "بعدی ➡️", callback_data: `m:${mail.id}:body:${page + 1}` });
    await this.editPrimary(mail, `<b>متن ایمیل — ${page + 1}/${chunks.length}</b>\n\n${esc(chunks[page]!)}`, [navigation]);
  }

  private async showFiles(mail: StoredMail): Promise<void> {
    const ids = [...mail.telegramMessageIds];
    for (const attachment of mail.attachments.filter((a) => a.isRealAttachment)) {
      const content = await this.imap.fetchAttachment(mail, attachment);
      const sent = await this.telegram.sendDocument(attachment.filename, content, mail.subject);
      ids.push(sent.message_id);
    }
    this.store.setTelegramMessages(mail.id, ids, mail.telegramCreatedAt);
    await this.editPrimary(this.store.getMail(mail.id)!, "📎 فایل‌ها در همین چت ارسال شدند. پس از بازگشت، فایل‌های موقت تلگرام پاک می‌شوند.", [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
    ]]);
  }

  private async showHiddenFiles(mail: StoredMail): Promise<void> {
    const hidden = mail.attachments.filter((attachment) => !attachment.isRealAttachment);
    const ids = [...mail.telegramMessageIds];
    for (const attachment of hidden) {
      const content = await this.imap.fetchAttachment(mail, attachment);
      const sent = await this.telegram.sendDocument(attachment.filename, content, `${mail.subject}\n${attachment.classificationReason ?? "تصویر مخفی‌شده"}`);
      ids.push(sent.message_id);
    }
    this.store.setTelegramMessages(mail.id, ids, mail.telegramCreatedAt);
    await this.editPrimary(this.store.getMail(mail.id)!, `🖼 ${hidden.length} تصویر مخفی‌شده برای بررسی ارسال شد. این موارد به‌صورت پیش‌فرض همراه Forward ارسال نمی‌شوند.`, [[
      { text: "↩️ بازگشت و پاک‌سازی", callback_data: `m:${mail.id}:summary`, style: "primary" }
    ]]);
  }

  private async chooseAiContext(mail: StoredMail): Promise<void> {
    await this.editPrimary(mail, "✨ سؤال شما با کدام محدوده پاسخ داده شود؟", [[
      { text: "📧 فقط این ایمیل", callback_data: `m:${mail.id}:askmail`, style: "primary" },
      { text: "📎 ایمیل و پیوست‌ها", callback_data: `m:${mail.id}:askfiles`, style: "primary" },
      { text: "🧵 کل مکالمه", callback_data: `m:${mail.id}:askthread`, style: "primary" }
    ], [{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
  }

  private async startAiQuestion(mail: StoredMail, context: "mail" | "attachments" | "thread"): Promise<void> {
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "ai_question", false, "formal", undefined, { kind: "ask", context });
    const label = context === "thread" ? "کل مکالمه" : context === "attachments" ? "ایمیل و پیوست‌های قابل استخراج" : "این ایمیل";
    const prompt = await this.telegram.sendMessage(`سؤال خود را درباره ${label} بنویسید:`, undefined, false, true);
    this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
    await this.editPrimary(mail, `✨ منتظر سؤال شما درباره ${label} هستم…`, [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
    ]]);
  }

  private async showThread(mail: StoredMail): Promise<void> {
    await this.editPrimary(mail, "🧵 در حال بازیابی مکالمه از Inbox، Sent و Archive…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
    const thread = await this.imap.findThread(mail);
    const timeline = thread.map((item, index) => `${index + 1}. ${item.receivedAt.toLocaleDateString("fa-IR", { timeZone: "Asia/Tehran" })} — ${item.from[0]?.name ?? item.from[0]?.address ?? "نامشخص"}\n${item.subject}`).join("\n\n");
    let summary = "";
    try { summary = await this.ai.ask(mail, "کل مکالمه را خلاصه کن، آخرین وضعیت و اقدام مورد انتظار از من را مشخص کن.", thread); }
    catch { summary = "خلاصه AI در دسترس نیست؛ Timeline بازیابی شد."; }
    const text = splitTelegramText(`<b>🧵 خلاصه مکالمه — ${thread.length} پیام</b>\n\n${esc(summary)}\n\n<b>Timeline</b>\n${esc(timeline)}`)[0]!;
    await this.editPrimary(mail, text, [[
      { text: "✨ سؤال از مکالمه", callback_data: `m:${mail.id}:askthread`, style: "primary" },
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
    ]]);
  }

  private async showSummary(mail: StoredMail): Promise<void> {
    const current = this.store.getMail(mail.id) ?? mail;
    const auxiliary = current.telegramMessageIds.slice(1);
    if (auxiliary.length) await this.telegram.deleteMessages(auxiliary).catch(() => false);
    this.store.setTelegramMessages(mail.id, current.telegramMessageIds.slice(0, 1), current.telegramCreatedAt);
    this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
    await this.editPrimary(this.store.getMail(mail.id)!, renderMail(this.store.getMail(mail.id)!), mailButtons(this.store.getMail(mail.id)!));
  }

  private async editPrimary(mail: StoredMail, text: string, buttons: Parameters<TelegramApi["editMessage"]>[2]): Promise<void> {
    const primaryId = mail.telegramMessageIds[0];
    if (!primaryId) throw new Error("Primary Telegram message is missing");
    await this.telegram.editMessage(primaryId, text, buttons);
  }

  private async done(mail: StoredMail): Promise<void> {
    return this.withMailAction(mail, "done", async () => {
    if (this.config.APP_MODE !== "live") {
      await this.telegram.sendMessage("🧪 حالت آزمایشی فعال است؛ ایمیل جابه‌جا نشد.", undefined, true);
      return;
    }
    this.store.setState(mail.id, "processing");
    try {
      await this.imap.archive(mail);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setState(mail.id, "done");
      this.logger.info("Mail archived and Telegram messages deleted", { mailId: mail.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setState(mail.id, "failed", message);
      await this.telegram.sendMessage(`❌ انجام عملیات ناموفق بود؛ ایمیل در Inbox باقی ماند.\n${esc(message)}`, [[{ text: "🔄 تلاش مجدد", callback_data: `m:${mail.id}:done`, style: "primary" }]]);
    }
    });
  }

  private async startReply(mail: StoredMail, replyAll: boolean): Promise<void> {
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "draft", replyAll);
    await this.editPrimary(mail, "✨ در حال آماده‌سازی پاسخ پیشنهادی AI…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
    try {
      const draft = await this.ai.draftReply(mail, "", "formal", replyAll, await this.imap.findThread(mail));
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", replyAll, "formal", draft);
      await this.showDraft(mail, draft, replyAll);
    } catch {
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "instruction", replyAll);
      await this.editPrimary(mail, "AI در دسترس نیست. بازگردید و بعداً دوباره تلاش کنید.", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
    }
  }

  private async startForward(mail: StoredMail): Promise<void> {
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_recipients", false, "formal", undefined, { kind: "forward" });
    const prompt = await this.telegram.sendMessage("آدرس ایمیل گیرنده را وارد کنید. برای چند گیرنده، آدرس‌ها را با ویرگول جدا کنید:", undefined, false, true);
    this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
    await this.editPrimary(mail, "↪️ منتظر آدرس گیرنده فوروارد هستم…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
  }

  private async handleText(message: TelegramMessage): Promise<void> {
    if (message.text?.trim().toLowerCase() === "/status") {
      const status = this.status();
      await this.telegram.sendMessage([
        `<b>وضعیت MailBot</b>`,
        `IMAP: ${status.imapConnected ? "✅ متصل" : "❌ قطع"}`,
        `Inbox: ${status.inboxCount}`,
        `Pending: ${status.pending}`,
        `Failed: ${status.failed}`,
        `آخرین Sync: ${esc(String(status.lastSuccessfulSync ?? "نامشخص"))}`,
        `آخرین Telegram Poll: ${esc(String(status.lastTelegramPoll ?? "نامشخص"))}`
      ].join("\n"), undefined, true);
      return;
    }
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID);
    if (!conversation || !["instruction", "manual_edit", "forward_recipients", "ai_question"].includes(conversation.mode)) return;
    const mail = this.store.getMail(conversation.mailId);
    if (!mail) return;
    if (conversation.mode === "ai_question") {
      const useThread = conversation.metadata?.context === "thread";
      const useAttachments = conversation.metadata?.context === "attachments";
      const thread = useThread ? await this.imap.findThread(mail) : [];
      const attachmentContext = useAttachments ? await this.extractAttachmentContext(mail) : "";
      let answer: string;
      try { answer = await this.ai.ask(mail, message.text!, thread, attachmentContext); }
      catch (error) { answer = `پاسخ AI در دسترس نیست: ${error instanceof Error ? error.message : String(error)}`; }
      await this.cleanupConversationMessages(mail, message.message_id);
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      await this.editPrimary(this.store.getMail(mail.id)!, `<b>✨ پاسخ AI</b>\n\n${esc(splitTelegramText(answer, 3400)[0]!)}`, [[
        { text: "✨ سؤال دیگر", callback_data: `m:${mail.id}:ask`, style: "primary" },
        { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
      ]]);
      return;
    }
    if (conversation.mode === "forward_recipients") {
      const recipients = this.parseRecipients(message.text!);
      if (!recipients.length) {
        await this.telegram.sendMessage("❌ آدرس معتبر پیدا نشد. نمونه: colleague@example.com", undefined, true);
        return;
      }
      let draft = "با درود و مهر\n\nجهت بررسی و اقدام ارسال می‌شود.\n\nبا سپاس";
      try { draft = await this.ai.draftForward(mail, "", conversation.tone); } catch { /* safe fallback */ }
      const metadata = { kind: "forward", recipients };
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", false, conversation.tone, draft, metadata);
      await this.cleanupConversationMessages(mail, message.message_id);
      await this.showForwardDraft(mail, draft, recipients);
      return;
    }
    const isForward = conversation.metadata?.kind === "forward";
    const draft = conversation.mode === "manual_edit"
      ? message.text!
      : isForward
        ? await this.ai.draftForward(mail, message.text!, conversation.tone)
        : await this.ai.draftReply(mail, message.text!, conversation.tone, conversation.replyAll, await this.imap.findThread(mail));
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", conversation.replyAll, conversation.tone, draft, conversation.metadata);
    await this.cleanupConversationMessages(mail, message.message_id);
    if (isForward) await this.showForwardDraft(mail, draft, this.forwardRecipients(conversation.metadata));
    else await this.showDraft(mail, draft, conversation.replyAll);
  }

  private async extractAttachmentContext(mail: StoredMail): Promise<string> {
    const sections: string[] = [];
    let remaining = this.config.AI_CONTEXT_MAX_CHARS;
    for (const attachment of mail.attachments.filter((item) => item.isRealAttachment)) {
      if (remaining <= 0) break;
      if (!canExtractAttachment(attachment.filename, attachment.contentType)) {
        sections.push(`FILE: ${attachment.filename}\n[نوع فایل برای استخراج متن پشتیبانی نمی‌شود]`); continue;
      }
      if (attachment.size > this.config.AI_ATTACHMENT_MAX_BYTES) {
        sections.push(`FILE: ${attachment.filename}\n[فایل از محدودیت تحلیل ${this.config.AI_ATTACHMENT_MAX_BYTES} بایت بزرگ‌تر است]`); continue;
      }
      try {
        const content = await this.imap.fetchAttachment(mail, attachment);
        const extracted = await extractAttachmentText(attachment.filename, attachment.contentType, content);
        const text = extracted?.slice(0, remaining);
        sections.push(text ? `FILE: ${attachment.filename}\n${text}` : `FILE: ${attachment.filename}\n[نوع فایل برای استخراج متن پشتیبانی نمی‌شود]`);
        remaining -= text?.length ?? 0;
      } catch (error) {
        sections.push(`FILE: ${attachment.filename}\n[خطا در استخراج: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
    return sections.join("\n\n");
  }

  private async cleanupConversationMessages(mail: StoredMail, incomingMessageId: number): Promise<void> {
    const auxiliary = [...mail.telegramMessageIds.slice(1), incomingMessageId];
    if (auxiliary.length) await this.telegram.deleteMessages(auxiliary).catch(() => false);
    this.store.setTelegramMessages(mail.id, mail.telegramMessageIds.slice(0, 1), mail.telegramCreatedAt);
  }

  private async changeTone(mail: StoredMail, tone: "formal" | "short" | "friendly"): Promise<void> {
    const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    if (!current || current.mailId !== mail.id) return;
    const isForward = current.metadata?.kind === "forward";
    const draft = isForward ? await this.ai.draftForward(mail, "", tone) : await this.ai.draftReply(mail, "", tone, current.replyAll, await this.imap.findThread(mail));
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", current.replyAll, tone, draft, current.metadata);
    if (isForward) await this.showForwardDraft(mail, draft, this.forwardRecipients(current.metadata));
    else await this.showDraft(mail, draft, current.replyAll);
  }

  private async showForwardDraft(mail: StoredMail, draft: string, recipients: string[]): Promise<void> {
    await this.editPrimary(mail, `<b>پیش‌نویس متن همراه فوروارد</b>\n<b>گیرندگان:</b> ${esc(recipients.join(", "))}\n<b>پیوست‌ها:</b> ${mail.attachments.filter((item) => item.isRealAttachment).length}\n\n${esc(draft)}`, [[
      { text: "✅ ارسال نهایی", callback_data: `m:${mail.id}:send`, style: "success" },
      { text: "💬 دستور به AI", callback_data: `m:${mail.id}:instruct`, style: "primary" },
      { text: "✏️ ویرایش مستقیم", callback_data: `m:${mail.id}:edit` },
      { text: "❌ لغو", callback_data: `m:${mail.id}:cancel`, style: "danger" }
    ], [
      { text: "رسمی", callback_data: `m:${mail.id}:formal` },
      { text: "کوتاه", callback_data: `m:${mail.id}:short` },
      { text: "دوستانه", callback_data: `m:${mail.id}:friendly` }
    ]]);
  }

  private parseRecipients(value: string): string[] {
    return [...new Set(value.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item)))];
  }

  private forwardRecipients(metadata?: Record<string, unknown>): string[] {
    const recipients = metadata?.recipients;
    if (!Array.isArray(recipients) || !recipients.every((item) => typeof item === "string")) throw new Error("Forward recipients are missing");
    return recipients;
  }

  private async showDraft(mail: StoredMail, draft: string, replyAll: boolean): Promise<void> {
    const primary = mail.replyTo.length ? mail.replyTo : mail.from;
    const excluded = new Set([this.config.SMTP_FROM.toLowerCase(), ...primary.map((a) => a.address.toLowerCase())]);
    const seen = new Set<string>();
    const copies = replyAll ? [...mail.to, ...mail.cc].filter((a) => {
      const key = a.address.toLowerCase();
      if (excluded.has(key) || seen.has(key)) return false;
      seen.add(key); return true;
    }) : [];
    const recipients = [...primary, ...copies].map((a) => a.address).join(", ");
    await this.editPrimary(mail, `<b>پیش‌نویس پاسخ AI</b>\n<b>گیرندگان:</b> ${esc(recipients)}\n\n${esc(draft)}`, [[
      { text: "✅ ارسال نهایی", callback_data: `m:${mail.id}:send`, style: "success" },
      { text: "💬 دستور به AI", callback_data: `m:${mail.id}:instruct`, style: "primary" },
      { text: "✏️ ویرایش مستقیم", callback_data: `m:${mail.id}:edit` },
      { text: "❌ لغو", callback_data: `m:${mail.id}:cancel`, style: "danger" }
    ], [
      { text: "رسمی", callback_data: `m:${mail.id}:formal` },
      { text: "کوتاه", callback_data: `m:${mail.id}:short` },
      { text: "دوستانه", callback_data: `m:${mail.id}:friendly` }
    ]]);
  }

  private async sendReply(mail: StoredMail): Promise<void> {
    return this.withMailAction(mail, "reply", async () => {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    if (!conversation?.draft) throw new Error("Reply draft is missing");
    const draft = buildReply(mail, conversation.draft, conversation.replyAll, this.config.SMTP_FROM);
    let outbound = this.store.getOutbound(mail.id);
    if (!outbound) {
      const messageId = this.outboundMessageId(mail.id);
      outbound = this.store.createOutbound(mail.id, "reply", messageId, await this.smtp.buildReply(mail, draft, messageId));
    }
    if (outbound.kind !== "reply") throw new Error("Outbound operation kind mismatch");
    let replySent = outbound.smtpAccepted;
    let sentCopySaved = outbound.sentSaved;
    try {
      if (!replySent) {
        if (await this.imap.sentContainsMessageId(outbound.messageId)) {
          replySent = true; sentCopySaved = true; this.store.markOutbound(mail.id, "sent");
        } else {
          if (outbound.smtpAttempted) throw new Error("Previous SMTP attempt has an unknown result; automatic resend was blocked to prevent a duplicate reply");
          this.store.markOutbound(mail.id, "attempt");
          await this.smtp.sendRaw([...draft.to, ...draft.cc].map((address) => address.address), outbound.raw);
          this.store.markOutbound(mail.id, "smtp");
        }
        replySent = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "sent_pending_sentcopy", conversation.replyAll, conversation.tone, conversation.draft);
      }
      if (!sentCopySaved) {
        await this.imap.appendSent(outbound.raw);
        sentCopySaved = true;
        this.store.markOutbound(mail.id, "sent");
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "sent_pending_archive", conversation.replyAll, conversation.tone, conversation.draft);
      }
      await this.imap.archive(mail);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setState(mail.id, "done");
      this.store.markOutbound(mail.id, "complete");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.logger.info("Reply sent, saved to Sent, mail archived and Telegram cleaned", { mailId: mail.id, replyAll: conversation.replyAll });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      await this.telegram.sendMessage(`${replySent ? `⚠️ پاسخ ارسال شد، اما مرحله ${retryStep} ناموفق بود. پاسخ دوباره ارسال نمی‌شود.` : "❌ پاسخ ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, replySent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send`, style: "primary" }]] : undefined);
    }
    });
  }

  private async sendForward(mail: StoredMail): Promise<void> {
    return this.withMailAction(mail, "forward", async () => {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    if (!conversation?.draft) throw new Error("Forward draft is missing");
    const recipients = this.forwardRecipients(conversation.metadata);
    let outbound = this.store.getOutbound(mail.id);
    if (!outbound) {
      const source = await this.imap.fetchSource(mail);
      const messageId = this.outboundMessageId(mail.id);
      outbound = this.store.createOutbound(mail.id, "forward", messageId, await this.smtp.buildForward(mail, recipients, conversation.draft, source, messageId));
    }
    if (outbound.kind !== "forward") throw new Error("Outbound operation kind mismatch");
    let forwardSent = outbound.smtpAccepted;
    let sentCopySaved = outbound.sentSaved;
    try {
      if (!forwardSent) {
        if (await this.imap.sentContainsMessageId(outbound.messageId)) {
          forwardSent = true; sentCopySaved = true; this.store.markOutbound(mail.id, "sent");
        } else {
          if (outbound.smtpAttempted) throw new Error("Previous SMTP attempt has an unknown result; automatic resend was blocked to prevent a duplicate forward");
          this.store.markOutbound(mail.id, "attempt");
          await this.smtp.sendRaw(recipients, outbound.raw);
          this.store.markOutbound(mail.id, "smtp");
        }
        forwardSent = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_sent_pending_sentcopy", false, conversation.tone, conversation.draft, conversation.metadata);
      }
      if (!sentCopySaved) {
        await this.imap.appendSent(outbound.raw);
        sentCopySaved = true;
        this.store.markOutbound(mail.id, "sent");
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_sent_pending_archive", false, conversation.tone, conversation.draft, conversation.metadata);
      }
      await this.imap.archive(mail);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setState(mail.id, "done");
      this.store.markOutbound(mail.id, "complete");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.logger.info("Mail forwarded with attachments, saved to Sent, archived and Telegram cleaned", { mailId: mail.id, recipientCount: recipients.length });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      await this.telegram.sendMessage(`${forwardSent ? `⚠️ فوروارد ارسال شد، اما مرحله ${retryStep} ناموفق بود. ایمیل دوباره ارسال نمی‌شود.` : "❌ فوروارد ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, forwardSent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send`, style: "primary" }]] : undefined);
    }
    });
  }

  private async withMailAction(mail: StoredMail, action: string, operation: () => Promise<void>): Promise<void> {
    const token = randomUUID();
    if (!this.store.acquireActionLock(mail.id, action, token)) {
      await this.telegram.sendMessage("⏳ یک عملیات دیگر برای این ایمیل در حال اجراست.", undefined, true);
      return;
    }
    try { await operation(); }
    finally { this.store.releaseActionLock(mail.id, token); }
  }

  private outboundMessageId(mailId: number): string {
    const domain = this.config.SMTP_FROM.split("@")[1] ?? "localhost";
    return `<mailbot-${mailId}-${randomUUID()}@${domain}>`;
  }
}
