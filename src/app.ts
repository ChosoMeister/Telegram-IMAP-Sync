import type { MailAccountAppConfig } from "./config.js";
import type { StoredMail } from "./domain/types.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { AiService } from "./ai.js";
import { buildReply } from "./ai.js";
import type { ImapService } from "./mail/imap.js";
import type { SmtpService } from "./mail/smtp.js";
import type { CalendarResponse } from "./mail/smtp.js";
import type { TelegramApi, TelegramMessage, TelegramUpdate } from "./telegram/api.js";
import { esc } from "./telegram/api.js";
import { mailButtons, renderMail } from "./telegram/render.js";
import { splitTelegramText } from "./mail/content.js";
import { canExtractAttachment, extractAttachmentText } from "./mail/extract.js";
import type { MailRuleService } from "./rules.js";
import { randomUUID } from "node:crypto";
import { describeError } from "./errors.js";
import type { MailAccountRuntime } from "./accounts.js";
import type { AsrCandidate, SpeechToTextService } from "./stt.js";
import type { TranscriptConsensus } from "./ai.js";

export class MailBotApp {
  private readonly startedAt = new Date();
  private syncRunning = false;
  private stopping = false;
  private readonly imapSupervisorRunning = new Set<string>();
  private readonly lastSuccessfulSync = new Map<string, Date>();
  private lastTelegramPoll?: Date;
  private readonly inboxCount = new Map<string, number>();
  private readonly accounts: MailAccountRuntime[];
  private readonly primaryAccountId: string;
  private jobWorkerRunning = false;
  private cardsVerified = false;
  constructor(
    private config: MailAccountAppConfig, private store: Store, private imap: ImapService,
    private smtp: SmtpService, private telegram: TelegramApi, private ai: AiService, private logger: Logger,
    private rules?: MailRuleService, additionalAccounts: MailAccountRuntime[] = [], private stt?: SpeechToTextService
  ) {
    this.accounts = [{ id: config.mailAccountId, label: config.mailAccountLabel, config, imap, smtp }, ...additionalAccounts];
    this.primaryAccountId = this.accounts[0]!.id;
  }

  async start(): Promise<void> {
    for (const account of this.accounts) {
      await this.connectAccount(account).catch((error) => this.logger.warn("Mail account startup deferred to reconnect supervisor", { accountId: account.id, error: describeError(error) }));
      void account.smtp.verify().catch((error) => this.logger.warn("SMTP verification failed; inbound mail remains available", {
        accountId: account.id, error: error instanceof Error ? error.message : String(error)
      }));
    }
    await this.syncInbox(this.config.TELEGRAM_INITIAL_IMPORT_SILENT);
    void this.pollTelegram();
    for (const account of this.accounts) void this.superviseImap(account);
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

  async stop(): Promise<void> { this.stopping = true; await Promise.all(this.accounts.map((account) => account.imap.stop())); }

  isHealthy(): boolean {
    const now = Date.now();
    const syncFresh = this.accounts.every((account) => {
      const last = this.lastSuccessfulSync.get(account.id);
      return Boolean(last && now - last.getTime() < Math.max(this.config.IMAP_RECONCILE_SECONDS * 3_000, 120_000));
    });
    const telegramFresh = this.lastTelegramPoll
      ? now - this.lastTelegramPoll.getTime() < 120_000
      : now - this.startedAt.getTime() < 90_000;
    return !this.stopping && this.accounts.every((account) => account.imap.isConnected()) && syncFresh && telegramFresh;
  }

  status(): Record<string, unknown> {
    return {
      ok: this.isHealthy(), imapConnected: this.accounts.every((account) => account.imap.isConnected()), syncRunning: this.syncRunning,
      accounts: Object.fromEntries(this.accounts.map((account) => [account.id, { label: account.label, imapConnected: account.imap.isConnected(), lastSuccessfulSync: this.lastSuccessfulSync.get(account.id)?.toISOString(), inboxCount: this.inboxCount.get(account.id) ?? 0, smtp: account.smtp.status() }])),
      lastTelegramPoll: this.lastTelegramPoll?.toISOString(), inboxCount: [...this.inboxCount.values()].reduce((sum, count) => sum + count, 0),
      jobs: this.store.jobCounts(), ai: this.ai.status(), stt: this.stt?.status() ?? { enabled: false }, smtp: this.smtp.status(), telegram: this.telegram.status(),
      backup: { lastSuccess: this.store.getKv("backup:last-success"), lastError: this.store.getKv("backup:last-error") }, ...this.store.counts()
    };
  }

  private async connectAccount(account: MailAccountRuntime): Promise<void> {
    await account.imap.connect();
    if (account.id === this.primaryAccountId) await account.imap.ensureMailboxes(this.rules?.destinations() ?? []);
  }

  private async superviseImap(account: MailAccountRuntime): Promise<void> {
    if (this.imapSupervisorRunning.has(account.id)) return;
    this.imapSupervisorRunning.add(account.id);
    let retryMs = 1000;
    try {
      while (!this.stopping) {
        try {
          if (!account.imap.isConnected()) {
            await this.connectAccount(account);
            this.logger.info("IMAP connection restored", { accountId: account.id });
            await this.syncInbox(false);
          }
          retryMs = 1000;
          await account.imap.waitForChanges(() => this.syncInbox(false));
          if (!this.stopping) throw new Error("IMAP connection closed");
        } catch (error) {
          if (this.stopping) break;
          this.logger.warn("IMAP disconnected; reconnect scheduled", {
            accountId: account.id, retryMs,
            error: error instanceof Error ? error.message : String(error)
          });
          await new Promise((resolve) => setTimeout(resolve, retryMs));
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      }
    } finally { this.imapSupervisorRunning.delete(account.id); }
  }

  async syncInbox(silent: boolean): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      for (const account of this.accounts) {
        if (!account.imap.isConnected()) { this.logger.debug("Inbox reconciliation deferred for disconnected account", { accountId: account.id }); continue; }
        await this.syncAccount(account);
      }
      await this.cleanupNonActionableCards();
      await this.normalizePendingThreadCards(silent);
      const analysisTargets = this.store.listPending().filter((mail) => !mail.analysis || mail.analysis.provider === "unavailable");
      for (const mail of analysisTargets) this.store.enqueueJob("analyze", mail.id);
      void this.processJobs();
    } finally { this.syncRunning = false; }
  }

  private async syncAccount(account: MailAccountRuntime): Promise<void> {
    try {
      const mailbox = account.imap.mailboxIdentity();
      const knownUids = this.store.listKnownUids(account.id, mailbox.path, mailbox.uidValidity);
      for (const incoming of await account.imap.scanInbox(knownUids)) {
        const result = this.store.upsertMail(incoming);
        const rule = account.id === this.primaryAccountId ? this.rules?.match(incoming) : undefined;
        const ruleAppliedKey = rule ? `mail-rule:${result.id}:${rule.name}` : undefined;
        if (rule && (!rule.actions.copyTo || this.store.getKv(ruleAppliedKey!) !== "applied")) {
          const mail = this.store.getMail(result.id)!;
          try {
            await account.imap.applyRule(mail, rule);
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
          continue;
        }
      }
      const liveUids = await account.imap.listInboxUids();
      this.inboxCount.set(account.id, liveUids.size);
      await this.reconcileRemovedMail(account.id, mailbox.path, mailbox.uidValidity, liveUids);
      this.lastSuccessfulSync.set(account.id, new Date());
    } catch (error) {
      const fields = { error: describeError(error) };
      if (account.imap.isConnected()) this.logger.error("Inbox reconciliation failed", { accountId: account.id, ...fields });
      else this.logger.warn("Inbox reconciliation interrupted by IMAP disconnect; reconnect will retry it", { accountId: account.id, ...fields });
    }
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
          if (!mail || (mail.analysis && mail.analysis.provider !== "unavailable") || mail.state === "done" || mail.state === "external_done") {
            this.store.completeJob(job.id); continue;
          }
          if (job.kind !== "analyze") throw new Error(`Unsupported job kind: ${job.kind}`);
          const analysis = await this.ai.analyze(mail);
          if (!analysis) throw new Error("All AI providers failed");
          this.store.setAnalysis(mail.id, analysis);
          const representative = this.store.threadRepresentative(mail.id);
          if (representative) await this.enrichTelegram(representative);
          this.store.completeJob(job.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const terminal = job.attempts >= 5;
          const retryMs = Math.min(60_000 * (2 ** Math.max(0, job.attempts - 1)), 3_600_000);
          if (terminal) {
            const mail = this.store.getMail(job.mailId);
            if (mail) {
              this.store.setAnalysis(mail.id, {
                importance: "normal", score: 0,
                summaryFa: "تحلیل هوشمند این ایمیل موقتاً در دسترس نیست.",
                suggestedAction: "متن ایمیل را بررسی کنید؛ پس از بازیابی سرویس AI، تحلیل همین کارت خودکار تکمیل می‌شود.",
                reason: message, provider: "unavailable", actionOwner: "unknown"
              });
              const representative = this.store.threadRepresentative(mail.id);
              if (representative) await this.enrichTelegram(representative).catch((renderError) =>
                this.logger.warn("Could not render AI-unavailable state", { mailId: mail.id, error: describeError(renderError) })
              );
            }
          }
          this.store.failJob(job.id, message, retryMs, terminal);
          this.logger.warn("Durable job failed", { jobId: job.id, kind: job.kind, mailId: job.mailId, attempts: job.attempts, terminal, error: message });
        }
      }
    } finally { this.jobWorkerRunning = false; }
  }

  private async reconcileRemovedMail(accountId: string, mailbox: string, uidValidity: string, liveUids: ReadonlySet<number>): Promise<void> {
    for (const mail of this.store.listActionable(accountId, mailbox, uidValidity)) {
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
    const thread = this.store.threadMembers(mail.id);
    const sent = await this.telegram.sendMessage(renderMail(mail, thread), mailButtons(mail, thread), silent);
    this.store.setTelegramMessages(mail.id, [sent.message_id]);
  }

  private async enrichTelegram(mail: StoredMail): Promise<void> {
    const primaryId = mail.telegramMessageIds[0];
    if (!primaryId) return;
    const thread = this.store.threadMembers(mail.id);
    try { await this.telegram.editMessage(primaryId, renderMail(mail, thread), mailButtons(mail, thread)); }
    catch (error) {
      const message = describeError(error);
      if (/message to edit not found/i.test(message)) {
        this.store.setTelegramMessages(mail.id, []);
        await this.publish(this.store.getMail(mail.id)!, true);
        this.logger.info("Missing Telegram card republished", { mailId: mail.id, staleMessageId: primaryId });
        return;
      }
      this.logger.warn("Telegram enrichment edit failed", { mailId: mail.id, error: message });
    }
  }

  private async normalizePendingThreadCards(silent: boolean): Promise<void> {
    const representatives = this.store.listPendingCards();
    const representativeIds = new Set(representatives.map((mail) => mail.id));
    for (const mail of this.store.listPending()) {
      if (representativeIds.has(mail.id) || !mail.telegramMessageIds.length) continue;
      await this.telegram.deleteMessages(mail.telegramMessageIds).catch(() => false);
      this.store.setTelegramMessages(mail.id, []);
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
    }
    for (const representative of representatives) {
      const current = this.store.getMail(representative.id)!;
      if (!current.telegramMessageIds.length) {
        await this.publish(current, silent);
        this.logger.info("Thread card published", { mailId: current.id, messageCount: this.store.threadMembers(current.id).length });
      } else if (!this.cardsVerified) await this.enrichTelegram(current);
    }
    this.cardsVerified = true;
  }

  private async rotatePending(): Promise<void> {
    const cutoff = Date.now() - this.config.TELEGRAM_REFRESH_HOURS * 3_600_000;
    const pending = this.store.listPendingCards();
    if (!pending.some((m) => m.telegramCreatedAt && m.telegramCreatedAt.getTime() < cutoff)) return;
    for (const mail of pending) {
      const oldIds = [...mail.telegramMessageIds];
      const thread = this.store.threadMembers(mail.id);
      const sent = await this.telegram.sendMessage(renderMail(mail, thread), mailButtons(mail, thread), true);
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
    else if (update.message?.text || update.message?.voice) await this.handleText(update.message);
  }

  private async handleCallback(callbackId: string, data: string): Promise<void> {
    const match = /^m:(\d+):(summary|body(?::\d+)?|allbody(?::\d+)?|files|hidden|thread|ask|askmail|askfiles|askthread|done|reply|replyall|forward|calaccept(?:confirm)?|caltentative(?:confirm)?|caldecline(?:confirm)?|instruct|voice|voiceconfirm|voiceedit|voiceraw|voiceclean|edit|formal|short|friendly|send|cancel)$/.exec(data);
    if (!match) return;
    const requestedMailId = Number(match[1]);
    const requestedMail = this.store.getMail(requestedMailId);
    const mail = requestedMail ? this.store.threadRepresentative(requestedMail.id) ?? requestedMail : undefined;
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
    this.logger.info("Telegram action received", { mailId: mail.id, requestedMailId, action });
    if (action === "summary") return this.showSummary(mail);
    if (action?.startsWith("body")) return this.showBody(mail, Number(action.split(":")[1] ?? 0));
    if (action?.startsWith("allbody")) return this.showAllBodies(mail, Number(action.split(":")[1] ?? 0));
    if (action === "files") return this.showFiles(mail);
    if (action === "hidden") return this.showHiddenFiles(mail);
    if (action === "thread") return this.showAllBodies(mail, 0);
    if (action === "ask") return this.chooseAiContext(mail);
    if (action === "askmail" || action === "askfiles" || action === "askthread") return this.startAiQuestion(mail, action === "askthread" ? "thread" : action === "askfiles" ? "attachments" : "mail");
    if (action === "done") return this.done(mail);
    if (action?.startsWith("calaccept") || action?.startsWith("caltentative") || action?.startsWith("caldecline")) {
      const response: CalendarResponse = action.startsWith("calaccept") ? "accept" : action.startsWith("caltentative") ? "tentative" : "decline";
      return action.endsWith("confirm") ? this.sendCalendarResponse(mail, response) : this.confirmCalendarResponse(mail, response);
    }
    if (action === "reply" || action === "replyall") return this.startReply(mail, action === "replyall");
    if (action === "forward") return this.startForward(mail);
    if (action === "instruct" || action === "edit") {
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, action === "edit" ? "manual_edit" : "instruction", current?.replyAll ?? false, current?.tone ?? "formal", current?.draft, current?.metadata);
      const isForward = current?.metadata?.kind === "forward";
      const prompt = await this.telegram.sendMessage(action === "edit"
        ? `متن نهایی ${isForward ? "همراه فوروارد" : "پاسخ"} را دقیقاً همان‌طور که باید ارسال شود بنویسید:`
        : `بگویید متن همراه ${isForward ? "فوروارد" : "پاسخ"} چه چیزی را بیان کند؛ AI آن را با متن ایمیل و لحن انتخابی ترکیب می‌کند:`, undefined, false, true);
      this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
      this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
      return;
    }
    if (action === "voice") {
      if (!this.config.VOICE_REPLY_ENABLED || !this.stt) {
        await this.editPrimary(mail, "🎙 پاسخ صوتی در تنظیمات سرویس فعال نیست.", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
        return;
      }
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
      const existingAuxiliary = mail.telegramMessageIds.slice(1);
      if (existingAuxiliary.length) await this.telegram.deleteMessages(existingAuxiliary).catch(() => false);
      const primaryIds = mail.telegramMessageIds.slice(0, 1);
      this.store.setTelegramMessages(mail.id, primaryIds, mail.telegramCreatedAt);
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "voice_instruction", current?.replyAll ?? false, current?.tone ?? "formal", current?.draft, current?.metadata);
      const prompt = await this.telegram.sendMessage(`Voice خود را با Reply مستقیم به همین پیام بفرستید. حداکثر ${this.config.VOICE_MAX_SECONDS} ثانیه؛ AI منظور شما را با متن ایمیل و لحن انتخابی ترکیب می‌کند.`, undefined, false, true);
      this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
      this.store.setTelegramMessages(mail.id, [...primaryIds, prompt.message_id], mail.telegramCreatedAt);
      await this.editPrimary(mail, "🎙 منتظر دستور صوتی شما هستم…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
      return;
    }
    if (action === "voiceconfirm") return this.confirmVoiceTranscript(mail);
    if (action === "voiceraw") return this.showVoiceTranscriptReview(mail, true);
    if (action === "voiceclean") return this.showVoiceTranscriptReview(mail, false);
    if (action === "voiceedit") {
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
      if (!current || !this.voiceTranscript(current.metadata)) return this.showSummary(mail);
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "voice_transcript_edit", current.replyAll, current.tone, current.draft, current.metadata);
      const prompt = await this.telegram.sendMessage("متن صحیح دستور صوتی را بنویسید. بعد از ثبت، پیش از ساخت پاسخ دوباره برای تأیید نمایش داده می‌شود:", undefined, false, true);
      this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
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

  private async showAllBodies(mail: StoredMail, requestedPage = 0): Promise<void> {
    const members = this.store.threadMembers(mail.id);
    const combined = members.map((item, index) => {
      const sender = item.from.map((address) => address.name ? `${address.name} <${address.address}>` : address.address).join(", ") || "نامشخص";
      const receivedAt = new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(item.receivedAt);
      return `${index + 1}. از: ${sender}\nزمان: ${receivedAt}\nموضوع: ${item.subject}\n\n${item.text || "متن قابل استخراج نیست."}`;
    }).join("\n\n────────────────────\n\n");
    const chunks = splitTelegramText(combined || "متن قابل استخراج نیست.");
    const page = Math.max(0, Math.min(requestedPage, chunks.length - 1));
    const navigation = [];
    if (page > 0) navigation.push({ text: "⬅️ قبلی", callback_data: `m:${mail.id}:allbody:${page - 1}` });
    navigation.push({ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" as const });
    if (page < chunks.length - 1) navigation.push({ text: "بعدی ➡️", callback_data: `m:${mail.id}:allbody:${page + 1}` });
    await this.editPrimary(mail, `<b>متن همه پیام‌ها — ${members.length} پیام — ${page + 1}/${chunks.length}</b>\n\n${esc(chunks[page]!)}`, [navigation]);
  }

  private async showFiles(mail: StoredMail): Promise<void> {
    return this.withMailAction(mail, "files", async () => {
    await this.editPrimary(mail, "📎 در حال دریافت و ارسال پیوست‌های اصلی…", [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
    ]]);
    const ids = [...mail.telegramMessageIds];
    for (const member of this.store.threadMembers(mail.id)) {
      for (const attachment of member.attachments.filter((a) => a.isRealAttachment)) {
        const content = await this.imapFor(member).fetchAttachment(member, attachment);
        const sent = await this.telegram.sendDocument(attachment.filename, content, member.subject);
        ids.push(sent.message_id);
      }
    }
    this.store.setTelegramMessages(mail.id, ids, mail.telegramCreatedAt);
    await this.editPrimary(this.store.getMail(mail.id)!, "📎 فایل‌ها در همین چت ارسال شدند. پس از بازگشت، فایل‌های موقت تلگرام پاک می‌شوند.", [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
    ]]);
    }, 3_000);
  }

  private async showHiddenFiles(mail: StoredMail): Promise<void> {
    return this.withMailAction(mail, "hidden-files", async () => {
    await this.editPrimary(mail, "🖼 در حال دریافت تصاویر مخفی‌شده…", [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
    ]]);
    const members = this.store.threadMembers(mail.id);
    const hidden = members.flatMap((member) => member.attachments.filter((attachment) => !attachment.isRealAttachment && attachment.classification !== "calendar").map((attachment) => ({ member, attachment })));
    const ids = [...mail.telegramMessageIds];
    for (const { member, attachment } of hidden) {
      const content = await this.imapFor(member).fetchAttachment(member, attachment);
      const sent = await this.telegram.sendDocument(attachment.filename, content, `${member.subject}\n${attachment.classificationReason ?? "تصویر مخفی‌شده"}`);
      ids.push(sent.message_id);
    }
    this.store.setTelegramMessages(mail.id, ids, mail.telegramCreatedAt);
    await this.editPrimary(this.store.getMail(mail.id)!, `🖼 ${hidden.length} تصویر مخفی‌شده برای بررسی ارسال شد. این موارد به‌صورت پیش‌فرض همراه Forward ارسال نمی‌شوند.`, [[
      { text: "↩️ بازگشت و پاک‌سازی", callback_data: `m:${mail.id}:summary`, style: "primary" }
    ]]);
    }, 3_000);
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
    this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
    this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
    await this.editPrimary(mail, `✨ منتظر سؤال شما درباره ${label} هستم…`, [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
    ]]);
  }

  private async showSummary(mail: StoredMail): Promise<void> {
    const current = this.store.getMail(mail.id) ?? mail;
    const auxiliary = current.telegramMessageIds.slice(1);
    if (auxiliary.length) await this.telegram.deleteMessages(auxiliary).catch(() => false);
    this.store.setTelegramMessages(mail.id, current.telegramMessageIds.slice(0, 1), current.telegramCreatedAt);
    this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const refreshed = this.store.getMail(mail.id)!;
    const thread = this.store.threadMembers(mail.id);
    await this.editPrimary(refreshed, renderMail(refreshed, thread), mailButtons(refreshed, thread));
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
      await this.editPrimary(mail, "⏳ در حال انتقال ایمیل به Archive و پاک‌سازی کارت…", []);
      const members = this.store.threadMembers(mail.id);
      await this.imapFor(mail).archiveMany(members);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setThreadState(mail.id, "done");
      for (const member of members) this.store.clearConversation(this.config.TELEGRAM_USER_ID, member.id);
      this.logger.info("Mail thread archived and Telegram messages deleted", { mailId: mail.id, messageCount: members.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.setState(mail.id, "failed", message);
      await this.editPrimary(mail, `❌ انجام عملیات ناموفق بود؛ ایمیل در Inbox باقی ماند.\n${esc(message)}`, [[{ text: "🔄 تلاش مجدد", callback_data: `m:${mail.id}:done`, style: "primary" }]]);
    }
    });
  }

  private async sendCalendarResponse(mail: StoredMail, response: CalendarResponse): Promise<void> {
    return this.withMailAction(mail, `calendar-${response}`, async () => {
      if (this.config.APP_MODE !== "live") {
        await this.telegram.sendMessage("🧪 حالت آزمایشی فعال است؛ پاسخ تقویم ارسال نشد.", undefined, true);
        return;
      }
      if (!mail.calendar || mail.calendar.method !== "REQUEST") throw new Error("این پیام یک دعوت تقویم قابل پاسخ نیست");
      const kind = `calendar_${response}` as const;
      let outbound = this.store.getOutbound(mail.id);
      if (!outbound) {
        const messageId = this.outboundMessageId(mail);
        const built = await this.smtpFor(mail).buildCalendarResponse(mail, response, messageId);
        outbound = this.store.createOutbound(mail.id, kind, messageId, built.raw);
      }
      if (outbound.kind !== kind) throw new Error("A different calendar response is already pending for this invitation");
      let smtpAccepted = outbound.smtpAccepted;
      let sentSaved = outbound.sentSaved;
      const label = ({ accept: "قبول", tentative: "شاید", decline: "رد" } as const)[response];
      try {
        await this.editPrimary(mail, `⏳ در حال ثبت «${label}»، ذخیره در Sent و آرشیو دعوت…`, []);
        if (!smtpAccepted) {
          if (await this.imapFor(mail).sentContainsMessageId(outbound.messageId)) {
            smtpAccepted = true; sentSaved = true; this.store.markOutbound(mail.id, "sent");
          } else {
            if (outbound.smtpAttempted) throw new Error("Previous SMTP attempt has an unknown result; automatic resend was blocked to prevent a duplicate calendar response");
            this.store.markOutbound(mail.id, "attempt");
            await this.smtpFor(mail).sendRaw([mail.calendar.organizer!.address], outbound.raw);
            this.store.markOutbound(mail.id, "smtp"); smtpAccepted = true;
          }
        }
        if (!sentSaved) {
          await this.imapFor(mail).appendSent(outbound.raw);
          this.store.markOutbound(mail.id, "sent"); sentSaved = true;
        }
        const members = this.store.threadMembers(mail.id);
        await this.imapFor(mail).archiveMany(members);
        await this.telegram.deleteMessages(mail.telegramMessageIds);
        this.store.setTelegramMessages(mail.id, []);
        this.store.setThreadState(mail.id, "done");
        this.store.markOutbound(mail.id, "complete");
        for (const member of members) this.store.clearConversation(this.config.TELEGRAM_USER_ID, member.id);
        this.logger.info("Calendar response sent, saved, and invitation archived", { mailId: mail.id, response, messageCount: members.length });
      } catch (error) {
        const message = describeError(error);
        this.store.setState(mail.id, "failed", message);
        const retryStep = sentSaved ? "آرشیو" : smtpAccepted ? "ذخیره در Sent" : "ارسال پاسخ";
        await this.editPrimary(mail, `❌ مرحله ${retryStep} ناموفق بود. دعوت در Inbox باقی ماند.\n${esc(message)}`, [[
          { text: `🔄 تلاش مجدد برای ${label}`, callback_data: `m:${mail.id}:cal${response}`, style: "primary" }
        ], [{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
      }
    });
  }

  private async confirmCalendarResponse(mail: StoredMail, response: CalendarResponse): Promise<void> {
    if (!mail.calendar || mail.calendar.method !== "REQUEST") throw new Error("این پیام یک دعوت تقویم قابل پاسخ نیست");
    const label = ({ accept: "قبول", tentative: "شاید", decline: "رد" } as const)[response];
    await this.editPrimary(mail, [
      `<b>تأیید پاسخ تقویم</b>`, "",
      `<b>رویداد:</b> ${esc(mail.calendar.summary || mail.subject)}`,
      `<b>انتخاب شما:</b> ${label}`,
      "", "پس از تأیید، پاسخ برای برگزارکننده ارسال و دعوت از Inbox آرشیو می‌شود."
    ].join("\n"), [[
      { text: `✅ تأیید نهایی: ${label}`, callback_data: `m:${mail.id}:cal${response}confirm`, style: response === "decline" ? "danger" : "success" },
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
    ]]);
  }

  private async startReply(mail: StoredMail, replyAll: boolean): Promise<void> {
    return this.withMailAction(mail, "draft", async () => {
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "draft", replyAll);
    await this.editPrimary(mail, "✨ در حال آماده‌سازی پاسخ پیشنهادی AI…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
    try {
      const draft = await this.ai.draftReply(mail, "", "formal", replyAll, await this.imapFor(mail).findThread(mail));
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", replyAll, "formal", draft);
      await this.showDraft(mail, draft, replyAll);
    } catch {
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "instruction", replyAll);
      await this.editPrimary(mail, "AI در دسترس نیست. بازگردید و بعداً دوباره تلاش کنید.", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
    }
    }, 3_000);
  }

  private async startForward(mail: StoredMail): Promise<void> {
    const existing = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    if (existing?.mode === "forward_recipients") {
      await this.editPrimary(mail, "↪️ منتظر آدرس گیرنده فوروارد هستم…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
      return;
    }
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_recipients", false, "formal", undefined, { kind: "forward" });
    const prompt = await this.telegram.sendMessage("آدرس ایمیل گیرنده را وارد کنید. برای چند گیرنده، آدرس‌ها را با ویرگول جدا کنید:", undefined, false, true);
    this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
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
        `کارت‌های Pending: ${status.pendingThreads}`,
        `پیام‌های Pending: ${status.pending}`,
        `Failed: ${status.failed}`,
        ...Object.entries(status.accounts as Record<string, any>).map(([id, account]) => `${esc(account.label ?? id)}: ${account.imapConnected ? "✅" : "❌"} — Inbox ${account.inboxCount} — Sync ${esc(String(account.lastSuccessfulSync ?? "نامشخص"))}`),
        `آخرین Telegram Poll: ${esc(String(status.lastTelegramPoll ?? "نامشخص"))}`
      ].join("\n"), undefined, true);
      return;
    }
    const promptMessageId = message.reply_to_message?.message_id;
    const conversation = promptMessageId ? this.store.getConversationByPrompt(this.config.TELEGRAM_USER_ID, promptMessageId) : undefined;
    if (!conversation || !["instruction", "voice_instruction", "voice_transcript_edit", "manual_edit", "forward_recipients", "ai_question"].includes(conversation.mode)) {
      const active = this.store.getConversation(this.config.TELEGRAM_USER_ID);
      if (active && ["instruction", "voice_instruction", "voice_transcript_edit", "manual_edit", "forward_recipients", "ai_question"].includes(active.mode)) {
        await this.telegram.sendMessage("برای جلوگیری از انتخاب ایمیل اشتباه، متن یا Voice را فقط با Reply مستقیم به پیام درخواست ربات ارسال کنید.", undefined, true);
      }
      return;
    }
    const mail = this.store.getMail(conversation.mailId);
    if (!mail) return;
    if (conversation.mode === "voice_instruction") {
      if (!message.voice) {
        await this.telegram.sendMessage("لطفاً یک Voice را با Reply مستقیم به پیام درخواست ربات ارسال کنید.", undefined, true);
        return;
      }
      if (message.voice.duration > this.config.VOICE_MAX_SECONDS) {
        await this.telegram.sendMessage(`❌ Voice از محدودیت ${this.config.VOICE_MAX_SECONDS} ثانیه طولانی‌تر است.`, undefined, true);
        return;
      }
      if ((message.voice.file_size ?? 0) > this.config.VOICE_MAX_BYTES) {
        await this.telegram.sendMessage("❌ حجم Voice از محدودیت تنظیم‌شده بیشتر است.", undefined, true);
        return;
      }
      if (!this.stt) throw new Error("Speech-to-text service is unavailable");
      const voiceStartedAt = Date.now();
      this.logger.info("Voice instruction received", { mailId: mail.id, durationSeconds: message.voice.duration, declaredBytes: message.voice.file_size });
      this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, message.message_id], mail.telegramCreatedAt);
      await this.editPrimary(mail, "🎧 در حال پردازش موازی Voice با دو مدل و داوری خروجی‌ها…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
      try {
        const downloaded = await this.telegram.downloadFile(message.voice.file_id, this.config.VOICE_MAX_BYTES);
        const extension = downloaded.filePath.split(".").pop()?.replace(/[^a-z0-9]/gi, "") || "ogg";
        const parallel = await this.stt.transcribe(downloaded.content, `voice.${extension}`);
        const consensus = await this.ai.reconcileVoiceTranscript(mail, parallel.candidates);
        this.logger.info("Voice instruction review prepared", { mailId: mail.id, durationMs: Date.now() - voiceStartedAt, candidates: parallel.candidates.length, failedModels: parallel.failedModels.length, judge: consensus.provider, confidence: consensus.confidence });
        const metadata = { ...(conversation.metadata ?? {}), voiceTranscript: consensus.finalTranscript, voiceCandidates: parallel.candidates, voiceConsensus: consensus, voiceFailedModels: parallel.failedModels };
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "voice_review", conversation.replyAll, conversation.tone, conversation.draft, metadata);
        await this.cleanupConversationMessages(mail, message.message_id);
        await this.showVoiceTranscriptReview(mail);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn("Voice instruction failed", { mailId: mail.id, error: reason });
        await this.editPrimary(mail, `❌ تبدیل Voice یا ساخت پاسخ ناموفق بود. Voice ذخیره نشد.\n${esc(reason)}`, [[
          { text: "🎙 تلاش مجدد", callback_data: `m:${mail.id}:voice`, style: "primary" },
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
        ]]);
      }
      return;
    }
    if (conversation.mode === "voice_transcript_edit") {
      if (!message.text?.trim()) {
        await this.telegram.sendMessage("متن اصلاح‌شده نمی‌تواند خالی باشد.", undefined, true);
        return;
      }
      const metadata = {
        ...(conversation.metadata ?? {}),
        voiceTranscript: message.text.trim(),
        voiceConsensus: { finalTranscript: message.text.trim(), confidence: 1, uncertainTerms: [], rationale: "متن توسط کاربر اصلاح شد." }
      };
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "voice_review", conversation.replyAll, conversation.tone, conversation.draft, metadata);
      await this.cleanupConversationMessages(mail, message.message_id);
      await this.showVoiceTranscriptReview(mail);
      return;
    }
    if (!message.text) {
      await this.telegram.sendMessage("در این مرحله باید متن ارسال کنید.", undefined, true);
      return;
    }
    if (conversation.mode === "ai_question") {
      await this.editPrimary(mail, "✨ در حال بررسی ایمیل و آماده‌سازی پاسخ AI…", [[
        { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
      ]]);
      const useThread = conversation.metadata?.context === "thread";
      const useAttachments = conversation.metadata?.context === "attachments";
      const thread = useThread ? await this.imapFor(mail).findThread(mail) : [];
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
      await this.editPrimary(mail, "✨ در حال آماده‌سازی متن پیشنهادی فوروارد…", [[
        { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
      ]]);
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
        : await this.ai.draftReply(mail, message.text!, conversation.tone, conversation.replyAll, await this.imapFor(mail).findThread(mail));
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", conversation.replyAll, conversation.tone, draft, conversation.metadata);
    await this.cleanupConversationMessages(mail, message.message_id);
    const voiceTranscript = this.voiceTranscript(conversation.metadata);
    if (isForward) await this.showForwardDraft(mail, draft, this.forwardRecipients(conversation.metadata), voiceTranscript);
    else await this.showDraft(mail, draft, conversation.replyAll, voiceTranscript);
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
        const content = await this.imapFor(mail).fetchAttachment(mail, attachment);
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

  private async confirmVoiceTranscript(mail: StoredMail): Promise<void> {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const transcript = this.voiceTranscript(conversation?.metadata);
    if (!conversation || !transcript) return this.showSummary(mail);
    await this.editPrimary(mail, "✨ متن Voice تأیید شد؛ در حال ساخت پیش‌نویس پاسخ…", [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
    ]]);
    const isForward = conversation.metadata?.kind === "forward";
    const draft = isForward
      ? await this.ai.draftForward(mail, transcript, conversation.tone)
      : await this.ai.draftReply(mail, transcript, conversation.tone, conversation.replyAll, await this.imapFor(mail).findThread(mail));
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", conversation.replyAll, conversation.tone, draft, conversation.metadata);
    if (isForward) await this.showForwardDraft(mail, draft, this.forwardRecipients(conversation.metadata), transcript);
    else await this.showDraft(mail, draft, conversation.replyAll, transcript);
  }

  private async showVoiceTranscriptReview(mail: StoredMail, showRaw = false): Promise<void> {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const transcript = this.voiceTranscript(conversation?.metadata);
    if (!conversation || !transcript) return this.showSummary(mail);
    const consensus = this.voiceConsensus(conversation.metadata);
    const candidates = this.voiceCandidates(conversation.metadata);
    const confidence = Math.round((consensus?.confidence ?? 0.5) * 100);
    const uncertain = consensus?.uncertainTerms.length ? `\n<b>عبارت‌های نامطمئن:</b> ${esc(consensus.uncertainTerms.join("، "))}` : "";
    const failed = Array.isArray(conversation.metadata?.voiceFailedModels) && conversation.metadata.voiceFailedModels.length
      ? `\n⚠️ ${conversation.metadata.voiceFailedModels.length} مدل پاسخ معتبر نداد؛ نتیجه با مدل سالم ساخته شد.` : "";
    const raw = showRaw
      ? `\n\n<b>خروجی خام مدل‌ها:</b>${candidates.map((item) => `\n\n<b>${esc(item.model)}:</b>\n${esc(this.cap(item.text, 900))}`).join("")}`
      : "";
    await this.editPrimary(mail, `<b>🎙 بازبینی متن Voice</b>\n<b>اطمینان داور:</b> ${confidence}%${uncertain}${failed}\n\n<b>متن نهایی پیشنهادی:</b>\n${esc(this.cap(transcript, 1_200))}${raw}`, [[
      { text: "✅ تأیید متن", callback_data: `m:${mail.id}:voiceconfirm`, style: "success" },
      { text: "✏️ اصلاح متن", callback_data: `m:${mail.id}:voiceedit`, style: "primary" }
    ], [
      { text: "🎙 ضبط مجدد", callback_data: `m:${mail.id}:voice` },
      { text: showRaw ? "📄 پنهان‌کردن خروجی‌ها" : "📄 خروجی هر دو مدل", callback_data: showRaw ? `m:${mail.id}:voiceclean` : `m:${mail.id}:voiceraw` }
    ], [
      { text: "❌ لغو", callback_data: `m:${mail.id}:cancel`, style: "danger" }
    ]]);
  }

  private voiceCandidates(metadata?: Record<string, unknown>): AsrCandidate[] {
    if (!Array.isArray(metadata?.voiceCandidates)) return [];
    return metadata.voiceCandidates.filter((item): item is AsrCandidate => Boolean(item) && typeof item === "object" && typeof (item as AsrCandidate).model === "string" && typeof (item as AsrCandidate).text === "string");
  }

  private voiceConsensus(metadata?: Record<string, unknown>): TranscriptConsensus | undefined {
    const value = metadata?.voiceConsensus as Partial<TranscriptConsensus> | undefined;
    if (!value || typeof value.finalTranscript !== "string" || typeof value.confidence !== "number") return undefined;
    return { finalTranscript: value.finalTranscript, confidence: value.confidence, uncertainTerms: Array.isArray(value.uncertainTerms) ? value.uncertainTerms.filter((item): item is string => typeof item === "string") : [], rationale: typeof value.rationale === "string" ? value.rationale : "", ...(typeof value.provider === "string" ? { provider: value.provider } : {}) };
  }

  private cap(value: string, max: number): string {
    return value.length > max ? `${value.slice(0, max)}…` : value;
  }

  private async cleanupConversationMessages(mail: StoredMail, incomingMessageId: number): Promise<void> {
    const auxiliary = [...mail.telegramMessageIds.slice(1), incomingMessageId];
    if (auxiliary.length) await this.telegram.deleteMessages(auxiliary).catch(() => false);
    this.store.setTelegramMessages(mail.id, mail.telegramMessageIds.slice(0, 1), mail.telegramCreatedAt);
  }

  private async changeTone(mail: StoredMail, tone: "formal" | "short" | "friendly"): Promise<void> {
    return this.withMailAction(mail, "draft", async () => {
    const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    if (!current || current.mailId !== mail.id) return;
    const isForward = current.metadata?.kind === "forward";
    await this.editPrimary(mail, "✨ در حال بازنویسی پیش‌نویس با لحن انتخابی…", [[
      { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
    ]]);
    const draft = isForward ? await this.ai.draftForward(mail, "", tone) : await this.ai.draftReply(mail, "", tone, current.replyAll, await this.imapFor(mail).findThread(mail));
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", current.replyAll, tone, draft, current.metadata);
    const voiceTranscript = this.voiceTranscript(current.metadata);
    if (isForward) await this.showForwardDraft(mail, draft, this.forwardRecipients(current.metadata), voiceTranscript);
    else await this.showDraft(mail, draft, current.replyAll, voiceTranscript);
    }, 3_000);
  }

  private async showForwardDraft(mail: StoredMail, draft: string, recipients: string[], voiceTranscript?: string): Promise<void> {
    await this.editPrimary(mail, `<b>پیش‌نویس متن همراه فوروارد</b>\n<b>گیرندگان:</b> ${esc(recipients.join(", "))}\n<b>پیوست‌ها:</b> ${mail.attachments.filter((item) => item.isRealAttachment).length}${this.renderVoiceTranscript(voiceTranscript)}\n\n<b>متن نهایی:</b>\n${esc(draft)}`, [[
      { text: "✅ ارسال نهایی", callback_data: `m:${mail.id}:send`, style: "success" },
      ...(this.config.VOICE_REPLY_ENABLED ? [{ text: "🎙 دستور صوتی", callback_data: `m:${mail.id}:voice` }] : []),
      { text: "💬 دستور متنی", callback_data: `m:${mail.id}:instruct`, style: "primary" }
    ], [
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

  private voiceTranscript(metadata?: Record<string, unknown>): string | undefined {
    return typeof metadata?.voiceTranscript === "string" ? metadata.voiceTranscript : undefined;
  }

  private renderVoiceTranscript(transcript?: string): string {
    if (!transcript) return "";
    const max = 1_000;
    const visible = transcript.length > max ? `${transcript.slice(0, max)}…` : transcript;
    return `\n\n<b>متن استخراج‌شده از Voice:</b>\n${esc(visible)}`;
  }

  private async showDraft(mail: StoredMail, draft: string, replyAll: boolean, voiceTranscript?: string): Promise<void> {
    const primary = mail.replyTo.length ? mail.replyTo : mail.from;
    const excluded = new Set([...this.ownAddresses().map((address) => address.toLowerCase()), ...primary.map((a) => a.address.toLowerCase())]);
    const seen = new Set<string>();
    const copies = replyAll ? [...mail.to, ...mail.cc].filter((a) => {
      const key = a.address.toLowerCase();
      if (excluded.has(key) || seen.has(key)) return false;
      seen.add(key); return true;
    }) : [];
    const recipients = [...primary, ...copies].map((a) => a.address).join(", ");
    await this.editPrimary(mail, `<b>پیش‌نویس پاسخ AI</b>\n<b>گیرندگان:</b> ${esc(recipients)}${this.renderVoiceTranscript(voiceTranscript)}\n\n<b>متن نهایی:</b>\n${esc(draft)}`, [[
      { text: "✅ ارسال نهایی", callback_data: `m:${mail.id}:send`, style: "success" },
      ...(this.config.VOICE_REPLY_ENABLED ? [{ text: "🎙 دستور صوتی", callback_data: `m:${mail.id}:voice` }] : []),
      { text: "💬 دستور متنی", callback_data: `m:${mail.id}:instruct`, style: "primary" }
    ], [
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
    const draft = buildReply(mail, conversation.draft, conversation.replyAll, this.ownAddresses());
    let outbound = this.store.getOutbound(mail.id);
    if (!outbound) {
      const messageId = this.outboundMessageId(mail);
      outbound = this.store.createOutbound(mail.id, "reply", messageId, await this.smtpFor(mail).buildReply(mail, draft, messageId));
    }
    if (outbound.kind !== "reply") throw new Error("Outbound operation kind mismatch");
    let replySent = outbound.smtpAccepted;
    let sentCopySaved = outbound.sentSaved;
    try {
      await this.editPrimary(mail, "⏳ در حال ارسال پاسخ، ذخیره در Sent و آرشیو ایمیل…", []);
      if (!replySent) {
        if (await this.imapFor(mail).sentContainsMessageId(outbound.messageId)) {
          replySent = true; sentCopySaved = true; this.store.markOutbound(mail.id, "sent");
        } else {
          if (outbound.smtpAttempted) throw new Error("Previous SMTP attempt has an unknown result; automatic resend was blocked to prevent a duplicate reply");
          this.store.markOutbound(mail.id, "attempt");
          await this.smtpFor(mail).sendRaw([...draft.to, ...draft.cc].map((address) => address.address), outbound.raw);
          this.store.markOutbound(mail.id, "smtp");
        }
        replySent = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "sent_pending_sentcopy", conversation.replyAll, conversation.tone, conversation.draft);
      }
      if (!sentCopySaved) {
        await this.imapFor(mail).appendSent(outbound.raw);
        sentCopySaved = true;
        this.store.markOutbound(mail.id, "sent");
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "sent_pending_archive", conversation.replyAll, conversation.tone, conversation.draft);
      }
      const members = this.store.threadMembers(mail.id);
      await this.imapFor(mail).archiveMany(members);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setThreadState(mail.id, "done");
      this.store.markOutbound(mail.id, "complete");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.logger.info("Reply sent, saved to Sent, mail archived and Telegram cleaned", { mailId: mail.id, replyAll: conversation.replyAll });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      await this.editPrimary(mail, `${replySent ? `⚠️ پاسخ ارسال شد، اما مرحله ${retryStep} ناموفق بود. پاسخ دوباره ارسال نمی‌شود.` : "❌ پاسخ ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, replySent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send`, style: "primary" }]] : [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
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
      const source = await this.imapFor(mail).fetchSource(mail);
      const messageId = this.outboundMessageId(mail);
      outbound = this.store.createOutbound(mail.id, "forward", messageId, await this.smtpFor(mail).buildForward(mail, recipients, conversation.draft, source, messageId));
    }
    if (outbound.kind !== "forward") throw new Error("Outbound operation kind mismatch");
    let forwardSent = outbound.smtpAccepted;
    let sentCopySaved = outbound.sentSaved;
    try {
      await this.editPrimary(mail, "⏳ در حال فوروارد، ذخیره در Sent و آرشیو ایمیل…", []);
      if (!forwardSent) {
        if (await this.imapFor(mail).sentContainsMessageId(outbound.messageId)) {
          forwardSent = true; sentCopySaved = true; this.store.markOutbound(mail.id, "sent");
        } else {
          if (outbound.smtpAttempted) throw new Error("Previous SMTP attempt has an unknown result; automatic resend was blocked to prevent a duplicate forward");
          this.store.markOutbound(mail.id, "attempt");
          await this.smtpFor(mail).sendRaw(recipients, outbound.raw);
          this.store.markOutbound(mail.id, "smtp");
        }
        forwardSent = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_sent_pending_sentcopy", false, conversation.tone, conversation.draft, conversation.metadata);
      }
      if (!sentCopySaved) {
        await this.imapFor(mail).appendSent(outbound.raw);
        sentCopySaved = true;
        this.store.markOutbound(mail.id, "sent");
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_sent_pending_archive", false, conversation.tone, conversation.draft, conversation.metadata);
      }
      const members = this.store.threadMembers(mail.id);
      await this.imapFor(mail).archiveMany(members);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setThreadState(mail.id, "done");
      this.store.markOutbound(mail.id, "complete");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.logger.info("Mail forwarded with attachments, saved to Sent, archived and Telegram cleaned", { mailId: mail.id, recipientCount: recipients.length });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      await this.editPrimary(mail, `${forwardSent ? `⚠️ فوروارد ارسال شد، اما مرحله ${retryStep} ناموفق بود. ایمیل دوباره ارسال نمی‌شود.` : "❌ فوروارد ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, forwardSent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send`, style: "primary" }]] : [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
    }
    });
  }

  private async withMailAction(mail: StoredMail, action: string, operation: () => Promise<void>, cooldownMs = 0): Promise<void> {
    const token = randomUUID();
    if (!this.store.acquireActionLock(mail.id, action, token)) {
      this.logger.info("Duplicate Telegram action suppressed", { mailId: mail.id, action });
      return;
    }
    try { await operation(); }
    catch (error) {
      const message = describeError(error);
      this.logger.warn("Telegram mail action failed", { mailId: mail.id, action, error: message });
      const current = this.store.getMail(mail.id);
      if (current?.telegramMessageIds[0]) {
        await this.editPrimary(current, `❌ عملیات ناموفق بود.\n${esc(message)}`, [[
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
        ]]).catch(() => undefined);
      }
    }
    finally { this.store.releaseActionLock(mail.id, token, cooldownMs); }
  }

  private accountFor(mail: StoredMail): MailAccountRuntime {
    const accountId = mail.accountId ?? this.primaryAccountId;
    const account = this.accounts.find((candidate) => candidate.id === accountId);
    if (!account) throw new Error(`Mail account is unavailable: ${accountId}`);
    return account;
  }

  private imapFor(mail: StoredMail): ImapService { return this.accountFor(mail).imap; }
  private smtpFor(mail: StoredMail): SmtpService { return this.accountFor(mail).smtp; }
  private ownAddress(mail: StoredMail): string { return this.accountFor(mail).config.SMTP_FROM; }
  private ownAddresses(): string[] { return this.accounts.map((account) => account.config.SMTP_FROM); }

  private outboundMessageId(mail: StoredMail): string {
    const domain = this.ownAddress(mail).split("@")[1] ?? "localhost";
    return `<mailbot-${mail.id}-${randomUUID()}@${domain}>`;
  }
}
