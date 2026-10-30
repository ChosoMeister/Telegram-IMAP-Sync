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
import { SafeScheduler } from "./scheduler.js";
import { DurableJobWorker } from "./jobs.js";
import { effectLabel, LearnedRuleService, type FeedbackChoice, type RuleProposal } from "./learned-rules.js";
import { planConversation } from "./conversation/planner.js";
import type { ConversationPlan, ConversationPlanAction } from "./conversation/plan.js";
import { MemoryService } from "./memory.js";
import { AutomationService } from "./automation.js";
import { createHash } from "node:crypto";

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
  private cardsVerified = false;
  private readonly scheduler: SafeScheduler;
  private readonly jobs: DurableJobWorker;
  private readonly learnedRules: LearnedRuleService;
  private readonly memory: MemoryService;
  private readonly automation: AutomationService;
  constructor(
    private config: MailAccountAppConfig, private store: Store, private imap: ImapService,
    private smtp: SmtpService, private telegram: TelegramApi, private ai: AiService, private logger: Logger,
    private rules?: MailRuleService, additionalAccounts: MailAccountRuntime[] = [], private stt?: SpeechToTextService
  ) {
    this.accounts = [{ id: config.mailAccountId, label: config.mailAccountLabel, config, imap, smtp }, ...additionalAccounts];
    this.primaryAccountId = this.accounts[0]!.id;
    this.scheduler = new SafeScheduler(logger);
    this.learnedRules = new LearnedRuleService(store);
    this.memory = new MemoryService(store);
    this.automation = new AutomationService(store, this.effectiveAutomationMode(), (mail) => this.archiveConversationTarget(mail, [mail.id]));
    this.jobs = new DurableJobWorker(store, async (mail) => {
      const guidance = [this.learnedRules.trustedGuidance(mail), this.memory.trustedGuidance(mail)].filter(Boolean).join("\n");
      const analysis = await ai.analyze(mail, guidance || undefined);
      return analysis ? this.learnedRules.applyMatching(mail, analysis) : undefined;
    }, telegram, logger, async (mailId) => {
      const analyzed = this.store.getMail(mailId);
      const activatedAt = Number(this.store.getKv(this.automationActivationKey()) ?? 0);
      if (analyzed) await this.automation.evaluate(analyzed, Boolean(activatedAt && (this.store.mailCreatedAt(mailId) ?? 0) >= activatedAt));
      const representative = this.store.threadRepresentative(mailId);
      if (representative) await this.enrichTelegram(representative);
    });
  }

  async start(): Promise<void> {
    if (this.config.AUTOMATION_MODE !== "off" && !this.store.getKv(this.automationActivationKey())) {
      this.store.setKv(this.automationActivationKey(), String(Date.now()));
    }
    const backfilledReferences = this.store.backfillTelegramCardReferences(this.config.TELEGRAM_USER_ID);
    if (backfilledReferences) this.logger.info("Existing Telegram card references backfilled", { count: backfilledReferences });
    for (const account of this.accounts) {
      await this.connectAccount(account).catch((error) => this.logger.warn("Mail account startup deferred to reconnect supervisor", { accountId: account.id, error: describeError(error) }));
      void account.smtp.verify().catch((error) => this.logger.warn("SMTP verification failed; inbound mail remains available", {
        accountId: account.id, error: error instanceof Error ? error.message : String(error)
      }));
    }
    await this.syncInbox(this.config.TELEGRAM_INITIAL_IMPORT_SILENT);
    void this.telegram.setMyCommands([
      { command: "status", description: "وضعیت خلاصه سرویس" },
      { command: "sync", description: "همگام‌سازی فوری Inbox" },
      { command: "accounts", description: "وضعیت حساب‌های ایمیل" },
      { command: "failed", description: "عملیات ناموفق" },
      { command: "backup", description: "وضعیت نسخه پشتیبان" },
      { command: "rules", description: "مدیریت قواعد یادگرفته‌شده" },
      { command: "memory", description: "حافظه تأییدشده دستیار" },
      { command: "automations", description: "قواعد خودکارسازی و حالت اجرا" },
      { command: "tasks", description: "کارها و یادآوری‌های باز" },
      { command: "search", description: "جست‌وجوی ایمیل‌های نگه‌داری‌شده" },
      { command: "diagnose", description: "گزارش کامل سلامت" },
      { command: "chatid", description: "نمایش شناسه چت برای Backup" }
    ]).catch((error) => this.logger.warn("Could not register Telegram commands", { error: describeError(error) }));
    void this.pollTelegram();
    for (const account of this.accounts) void this.superviseImap(account);
    this.scheduler.every("inbox-reconciliation", this.config.IMAP_RECONCILE_SECONDS * 1000, () => this.syncInbox(false));
    this.scheduler.every("telegram-queue-rotation", 60 * 60 * 1000, () => this.rotatePending());
    this.scheduler.every("durable-jobs", 5_000, () => this.processJobs());
    this.scheduler.every("telegram-commands", 1_000, () => this.processTelegramCommands());
    this.scheduler.every("task-reminders", 30_000, () => this.processTaskReminders());
    await this.processTaskReminders();
    const purge = () => {
      const removed = this.store.purgeCompleted(this.config.DATA_RETENTION_DAYS);
      if (removed) this.logger.info("Expired completed local records purged", { removed, retentionDays: this.config.DATA_RETENTION_DAYS });
    };
    purge();
    this.scheduler.every("data-retention", 24 * 60 * 60 * 1000, purge);
  }

  async stop(): Promise<void> { this.stopping = true; this.scheduler.stop(); await Promise.all(this.accounts.map((account) => account.imap.stop())); }

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
    const learnedRules = this.learnedRules.list();
    return {
      ok: this.isHealthy(), imapConnected: this.accounts.every((account) => account.imap.isConnected()), syncRunning: this.syncRunning,
      accounts: Object.fromEntries(this.accounts.map((account) => [account.id, { label: account.label, imapConnected: account.imap.isConnected(), imap: account.imap.status(), lastSuccessfulSync: this.lastSuccessfulSync.get(account.id)?.toISOString(), inboxCount: this.inboxCount.get(account.id) ?? 0, smtp: account.smtp.status() }])),
      lastTelegramPoll: this.lastTelegramPoll?.toISOString(), inboxCount: [...this.inboxCount.values()].reduce((sum, count) => sum + count, 0),
      jobs: this.store.jobCounts(), ai: this.ai.status(), stt: this.stt?.status() ?? { enabled: false }, smtp: this.smtp.status(), telegram: this.telegram.status(),
      learnedRules: { total: learnedRules.length, enabled: learnedRules.filter((rule) => rule.enabled).length },
      memory: { active: this.memory.list().length, confirmed: this.memory.list().filter((item) => item.confidence === "confirmed").length },
      automation: { mode: this.config.AUTOMATION_MODE, effectiveMode: this.effectiveAutomationMode(), policies: this.store.listAutomationPolicies(true).length },
      backup: {
        lastSuccess: this.store.getKv("backup:last-success"), lastError: this.store.getKv("backup:last-error"),
        telegramLastSuccess: this.store.getKv("backup:telegram-last-success"), telegramLastError: this.store.getKv("backup:telegram-last-error")
      }, ...this.store.counts()
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
          account.imap.markReconnecting();
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
              this.store.setState(mail.id, "done");
              this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
              this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "mail_rule_move" });
              continue;
            }
          } catch (error) {
            this.logger.warn("Mail rule failed; keeping message actionable", { mailId: mail.id, rule: rule.name, error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!result.created) {
          continue;
        }
        const createdMail = this.store.getMail(result.id)!;
        const activatedAt = Number(this.store.getKv(this.automationActivationKey()) ?? 0);
        const automationDecision = await this.automation.evaluate(createdMail,
          Boolean(activatedAt && (this.store.mailCreatedAt(result.id) ?? 0) >= activatedAt));
        if (automationDecision?.outcome === "executed") continue;
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
    if (!this.stopping) await this.jobs.process();
  }

  private async reconcileRemovedMail(accountId: string, mailbox: string, uidValidity: string, liveUids: ReadonlySet<number>): Promise<void> {
    for (const mail of this.store.listActionable(accountId, mailbox, uidValidity)) {
      const key = `missing-inbox:${mail.id}`;
      if (liveUids.has(mail.uid)) { this.store.deleteKv(key); continue; }
      const misses = Number(this.store.getKv(key) ?? 0) + 1;
      if (misses < 2) { this.store.setKv(key, String(misses)); continue; }
      this.store.setState(mail.id, "external_done");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "external_inbox_move" });
      this.store.deleteKv(key);
      this.logger.info("External Inbox move durably recorded; Telegram cleanup queued", { mailId: mail.id, uid: mail.uid });
    }
  }

  private async cleanupNonActionableCards(): Promise<void> {
    for (const mail of this.store.listNonActionableWithTelegram()) {
      this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "startup_reconciliation" });
    }
  }

  private async publish(mail: StoredMail, silent: boolean): Promise<void> {
    const thread = this.store.threadMembers(mail.id);
    const sent = await this.telegram.sendMessage(renderMail(mail, thread), mailButtons(mail, thread), silent);
    this.store.setTelegramMessages(mail.id, [sent.message_id]);
    this.store.registerTelegramMessage({ chatId: sent.chat.id, messageId: sent.message_id, mailId: mail.id,
      role: "card", scopeMailIds: thread.map((member) => member.id) });
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
      this.store.registerTelegramMessage({ chatId: sent.chat.id, messageId: sent.message_id, mailId: mail.id,
        role: "card", scopeMailIds: thread.map((member) => member.id) });
      this.store.setTelegramMessages(mail.id, [sent.message_id, ...oldIds]);
      if (oldIds.length) await this.telegram.deleteMessages(oldIds).catch(() => false);
      for (const oldId of oldIds) this.store.deactivateTelegramMessage(this.config.TELEGRAM_USER_ID, oldId);
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
          try {
            await this.handleUpdate(update);
            offset = Math.max(offset, update.update_id + 1);
            this.store.setKv("telegram_offset", String(offset));
          } catch (error) {
            this.logger.error("Telegram update handling failed", {
              updateId: update.update_id,
              error: error instanceof Error ? error.message : String(error)
            });
            await new Promise((resolve) => setTimeout(resolve, 1000));
            break;
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
    if (update.callback_query?.data?.startsWith("sys:")) await this.handleSystemCallback(update.callback_query.id, update.callback_query.data,
      update.callback_query.message?.message_id, update.callback_query.message?.chat.id);
    else if (update.callback_query?.data) await this.handleCallback(update.callback_query.id, update.callback_query.data);
    else if (update.message?.text || update.message?.voice) {
      this.store.enqueueTelegramCommand({ updateId: update.update_id, userId, chatId: update.message.chat.id,
        messageId: update.message.message_id,
        ...(update.message.reply_to_message ? { replyToMessageId: update.message.reply_to_message.message_id } : {}),
        ...(update.message.text ? { text: update.message.text } : {}),
        ...(update.message.voice ? { voice: update.message.voice as unknown as Record<string, unknown> } : {}) });
      await this.processTelegramCommands();
    }
  }

  private async processTelegramCommands(): Promise<void> {
    for (let command = this.store.leaseTelegramCommand(); command; command = this.store.leaseTelegramCommand()) {
      try {
        await this.handleText({ message_id: command.messageId, chat: { id: command.chatId }, from: { id: command.userId },
          ...(command.replyToMessageId ? { reply_to_message: { message_id: command.replyToMessageId } } : {}),
          ...(command.text ? { text: command.text } : {}),
          ...(command.voice ? { voice: command.voice as NonNullable<TelegramMessage["voice"]> } : {}) });
        this.store.completeTelegramCommand(command.id);
      } catch (error) {
        const reason = describeError(error);
        this.store.failTelegramCommand(command.id, reason, Math.min(60_000, 2_000 * (2 ** command.attempts)), command.attempts >= 5);
        this.logger.warn("Durable Telegram command failed", { updateId: command.updateId, attempts: command.attempts, error: reason });
      }
    }
  }

  private async handleSystemCallback(callbackId: string, data: string, messageId?: number, chatId = this.config.TELEGRAM_USER_ID): Promise<void> {
    await this.answerCallback(callbackId);
    if (data === "sys:close" && messageId) await this.telegram.deleteMessages([messageId]).catch(() => false);
    const bulkCalendarMatch = /^sys:bulkcal:(confirm|view|cancel)$/.exec(data);
    if (bulkCalendarMatch && messageId) {
      if (bulkCalendarMatch[1] === "cancel") {
        this.store.deactivateTelegramMessage(chatId, messageId);
        await this.telegram.deleteMessages([messageId]).catch(() => false);
      } else if (bulkCalendarMatch[1] === "view") await this.showBulkCalendarSnapshot(chatId, messageId);
      else await this.confirmBulkCalendarArchive(chatId, messageId);
      return;
    }
    const bulkSenderMatch = /^sys:bulksender:(confirm|view|cancel)$/.exec(data);
    if (bulkSenderMatch && messageId) {
      if (bulkSenderMatch[1] === "cancel") {
        const action = this.store.getPendingBulkAction(chatId, messageId);
        if (action?.state === "pending") this.store.finishPendingBulkAction(action.id, "cancelled");
        await this.telegram.deleteMessages([messageId]).catch(() => false);
      } else if (bulkSenderMatch[1] === "view") await this.showBulkSenderSnapshot(chatId, messageId);
      else await this.confirmBulkSenderArchive(chatId, messageId);
      return;
    }
    const ruleMatch = /^sys:rule:(\d+):toggle$/.exec(data);
    if (ruleMatch && messageId) {
      this.learnedRules.toggle(Number(ruleMatch[1]));
      const rendered = this.renderRulesCommand();
      await this.telegram.editMessage(messageId, rendered.text, rendered.buttons);
    }
    const memoryMatch = /^sys:memory:(\d+):toggle$/.exec(data);
    if (memoryMatch && messageId) {
      this.memory.toggle(Number(memoryMatch[1]));
      const rendered = this.renderMemoryCommand();
      await this.telegram.editMessage(messageId, rendered.text, rendered.buttons);
    }
    const taskMatch = /^sys:task:(\d+):(done|cancel)$/.exec(data);
    if (taskMatch && messageId) {
      this.store.setMailTaskState(Number(taskMatch[1]), taskMatch[2] === "done" ? "done" : "cancelled");
      const rendered = this.renderTasksCommand();
      await this.telegram.editMessage(messageId, rendered.text, rendered.buttons);
    }
    const automationMatch = /^sys:auto:(\d+):toggle$/.exec(data);
    if (automationMatch && messageId) {
      const policy = this.store.getAutomationPolicy(Number(automationMatch[1]));
      if (policy) this.store.setAutomationPolicyStatus(policy.id, policy.status === "active" ? "paused" : "active");
      const rendered = this.renderAutomationsCommand();
      await this.telegram.editMessage(messageId, rendered.text, rendered.buttons);
    }
  }

  private async handleCallback(callbackId: string, data: string): Promise<void> {
    const match = /^m:(\d+):(summary|body(?::\d+)?|allbody(?::\d+)?|files|hidden|thread|ask|askmail|askfiles|askthread|retryai|feedback|fbimportance|fbnotmine|fbinformational|fbi(?:critical|high|normal|low)|fbonce|fbsender|fbsubject|fbdomain|fbconfirm|done|reply|replyall|forward|calaccept(?:confirm)?|caltentative(?:confirm)?|caldecline(?:confirm)?|instruct|voice|voiceconfirm|voiceedit|voiceraw|voiceclean|edit|formal|short|friendly|send(?::[a-f0-9]{12})?|cancel)$/.exec(data);
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
    if (action === "retryai") return this.retryAnalysis(mail);
    if (action === "feedback") return this.showFeedbackMenu(mail);
    if (action === "fbimportance") return this.showImportanceFeedback(mail);
    if (action === "fbnotmine") return this.acceptFeedbackChoice(mail, { effect: "not_mine" });
    if (action === "fbinformational") return this.acceptFeedbackChoice(mail, { effect: "informational" });
    if (action?.startsWith("fbi")) return this.acceptFeedbackChoice(mail, { effect: "importance", effectValue: action.slice(3) });
    if (action === "fbonce") { this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id); return this.showSummary(mail); }
    if (action === "fbsender" || action === "fbsubject" || action === "fbdomain") {
      return this.prepareFeedbackRule(mail, action === "fbdomain" ? "domain" : action === "fbsubject" ? "sender_subject" : "sender");
    }
    if (action === "fbconfirm") return this.confirmFeedbackRule(mail);
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
    if (action?.startsWith("send")) {
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
      const suppliedToken = action.split(":")[1];
      if (!current?.draft) throw new Error("Reply or Forward draft is missing");
      if (!suppliedToken || suppliedToken !== this.draftApprovalToken(mail, current.draft, current.replyAll, current.metadata)) {
        const warning = "⚠️ تأیید قبلی منقضی شده است؛ نسخه فعلی را دوباره بررسی و دکمه جدید را بزنید.";
        if (current.metadata?.kind === "forward") await this.showForwardDraft(mail, current.draft, this.forwardRecipients(current.metadata), this.voiceTranscript(current.metadata), warning);
        else await this.showDraft(mail, current.draft, current.replyAll, this.voiceTranscript(current.metadata), warning);
        return;
      }
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

  private async showFeedbackMenu(mail: StoredMail): Promise<void> {
    if (!mail.analysis || mail.analysis.provider === "unavailable") return this.showSummary(mail);
    await this.editPrimary(mail, [
      "<b>🎯 اصلاح تحلیل</b>", "", "این اصلاح ابتدا فقط روی همین ایمیل اعمال می‌شود.",
      "برای ساخت قاعده دائمی، محدوده و متن Rule را جداگانه تأیید خواهید کرد."
    ].join("\n"), [
      [{ text: "📊 اهمیت اشتباه است", callback_data: `m:${mail.id}:fbimportance`, style: "primary" }],
      [{ text: "👤 اقدام مربوط به من نیست", callback_data: `m:${mail.id}:fbnotmine` }],
      [{ text: "ℹ️ فقط اطلاع‌رسانی است", callback_data: `m:${mail.id}:fbinformational` }],
      [{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]
    ]);
  }

  private async showImportanceFeedback(mail: StoredMail): Promise<void> {
    await this.editPrimary(mail, "<b>اهمیت صحیح این ایمیل چیست؟</b>", [
      [
        { text: "🔴 خیلی مهم", callback_data: `m:${mail.id}:fbicritical`, style: "danger" },
        { text: "🟠 مهم", callback_data: `m:${mail.id}:fbihigh` }
      ],
      [
        { text: "🟡 عادی", callback_data: `m:${mail.id}:fbinormal` },
        { text: "🟢 کم‌اهمیت", callback_data: `m:${mail.id}:fbilow` }
      ],
      [{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:feedback` }]
    ]);
  }

  private async acceptFeedbackChoice(mail: StoredMail, choice: FeedbackChoice): Promise<void> {
    if (!mail.analysis || mail.analysis.provider === "unavailable") return this.showSummary(mail);
    const corrected = this.learnedRules.applyUserCorrection(mail.analysis, choice);
    this.store.setAnalysis(mail.id, corrected);
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "feedback_scope", false, "formal", undefined, { feedback: choice });
    const sender = mail.from[0]?.address ?? "نامشخص";
    const domain = sender.includes("@") ? sender.split("@")[1] : undefined;
    await this.editPrimary(this.store.getMail(mail.id)!, [
      `<b>✅ همین ایمیل اصلاح شد:</b> ${esc(effectLabel(choice.effect, choice.effectValue))}`,
      "", "آیا این ترجیح برای ایمیل‌های آینده نیز ذخیره شود؟"
    ].join("\n"), [
      [{ text: "فقط همین ایمیل", callback_data: `m:${mail.id}:fbonce`, style: "success" }],
      [{ text: `همین فرستنده`, callback_data: `m:${mail.id}:fbsender` }],
      [{ text: "همین فرستنده + موضوع", callback_data: `m:${mail.id}:fbsubject` }],
      ...(domain ? [[{ text: `همه فرستنده‌های @${domain.slice(0, 35)}`, callback_data: `m:${mail.id}:fbdomain` }]] : []),
      [{ text: "❌ لغو", callback_data: `m:${mail.id}:cancel`, style: "danger" }]
    ]);
  }

  private async prepareFeedbackRule(mail: StoredMail, scope: "sender" | "sender_subject" | "domain"): Promise<void> {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const feedback = this.feedbackChoice(conversation?.metadata?.feedback);
    if (!feedback) return this.showFeedbackMenu(mail);
    const proposal = this.learnedRules.proposal(mail, feedback, scope);
    if (!proposal) return this.showSummary(mail);
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "feedback_confirm", false, "formal", undefined, { proposal });
    const condition = scope === "domain" ? `دامنه فرستنده برابر <code>${esc(proposal.senderDomain!)}</code>`
      : scope === "sender_subject" ? `فرستنده <code>${esc(proposal.senderEmail!)}</code> و موضوع برابر «${esc(proposal.subjectPattern!)}»`
        : `فرستنده برابر <code>${esc(proposal.senderEmail!)}</code>`;
    await this.editPrimary(mail, [
      "<b>تأیید Rule یادگرفته‌شده</b>", "", `<b>حساب:</b> ${esc(mail.accountLabel ?? proposal.accountId)}`,
      `<b>اگر:</b> ${condition}`, `<b>آنگاه:</b> ${esc(effectLabel(proposal.effect, proposal.effectValue))}`,
      "", "این Rule فقط تحلیل را اصلاح می‌کند و هیچ ایمیلی را جابه‌جا، حذف یا ارسال نمی‌کند."
    ].join("\n"), [[
      { text: "✅ ذخیره Rule", callback_data: `m:${mail.id}:fbconfirm`, style: "success" },
      { text: "❌ لغو", callback_data: `m:${mail.id}:cancel`, style: "danger" }
    ]]);
  }

  private async confirmFeedbackRule(mail: StoredMail): Promise<void> {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const proposal = this.ruleProposal(conversation?.metadata?.proposal);
    if (!proposal) return this.showFeedbackMenu(mail);
    const rule = this.learnedRules.save(proposal);
    this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
    this.logger.info("User-confirmed learned analysis rule saved", { ruleId: rule.id, mailId: mail.id, accountId: rule.accountId, scope: rule.scope, effect: rule.effect });
    await this.showSummary(this.store.getMail(mail.id)!);
  }

  private feedbackChoice(value: unknown): FeedbackChoice | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    if (!["importance", "not_mine", "informational"].includes(String(candidate.effect))) return undefined;
    if (candidate.effect === "importance" && !["critical", "high", "normal", "low"].includes(String(candidate.effectValue))) return undefined;
    return { effect: candidate.effect as FeedbackChoice["effect"], ...(typeof candidate.effectValue === "string" ? { effectValue: candidate.effectValue } : {}) };
  }

  private ruleProposal(value: unknown): RuleProposal | undefined {
    if (!value || typeof value !== "object") return undefined;
    const candidate = value as Record<string, unknown>;
    const feedback = this.feedbackChoice(candidate);
    if (!feedback || !["sender", "sender_subject", "domain"].includes(String(candidate.scope)) || typeof candidate.accountId !== "string" || typeof candidate.sourceMailId !== "number") return undefined;
    if (candidate.sourceMailId <= 0 || candidate.sourceMailId !== Math.trunc(candidate.sourceMailId)) return undefined;
    return {
      ...feedback, accountId: candidate.accountId, scope: candidate.scope as RuleProposal["scope"], sourceMailId: candidate.sourceMailId,
      ...(typeof candidate.senderEmail === "string" ? { senderEmail: candidate.senderEmail } : {}),
      ...(typeof candidate.senderDomain === "string" ? { senderDomain: candidate.senderDomain } : {}),
      ...(typeof candidate.subjectPattern === "string" ? { subjectPattern: candidate.subjectPattern } : {})
    };
  }

  private renderRulesCommand(): { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } {
    const allRules = this.learnedRules.list();
    const rules = allRules.slice(0, 10);
    const text = rules.length ? [
      `<b>🎯 قواعد یادگرفته‌شده (${allRules.length})</b>`, "",
      ...rules.map((rule) => `${rule.enabled ? "✅" : "⏸"} <b>#${rule.id}</b> [${esc(rule.accountId.slice(0, 60))}]\n${esc(this.learnedRules.describe(rule).slice(0, 280))}`),
      ...(allRules.length > 10 ? ["", "فقط ۱۰ Rule آخر نمایش داده شده است."] : [])
    ].join("\n\n") : "هیچ Rule یادگرفته‌شده‌ای ثبت نشده است.";
    const buttons = rules.map((rule) => [{
      text: `${rule.enabled ? "⏸ غیرفعال" : "▶️ فعال"} #${rule.id}`,
      callback_data: `sys:rule:${rule.id}:toggle`
    }]);
    buttons.push([{ text: "✖️ بستن", callback_data: "sys:close" }]);
    return { text, buttons };
  }

  private async retryAnalysis(mail: StoredMail): Promise<void> {
    if (mail.analysis?.provider !== "unavailable" || !this.store.retryAnalysis(mail.id)) return this.showSummary(mail);
    const refreshed = this.store.getMail(mail.id)!;
    const thread = this.store.threadMembers(refreshed.id);
    await this.editPrimary(refreshed, renderMail(refreshed, thread), mailButtons(refreshed, thread));
    await this.processJobs();
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
      this.store.setThreadState(mail.id, "done");
      for (const member of members) this.store.clearConversation(this.config.TELEGRAM_USER_ID, member.id);
      this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "done" });
      await this.processJobs();
      this.logger.info("Mail thread archived; Telegram cleanup queued", { mailId: mail.id, messageCount: members.length });
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
        this.store.setThreadState(mail.id, "done");
        this.store.markOutbound(mail.id, "complete");
        for (const member of members) this.store.clearConversation(this.config.TELEGRAM_USER_ID, member.id);
        this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "calendar_complete" });
        await this.processJobs();
        this.logger.info("Calendar response sent, saved, and invitation archived; Telegram cleanup queued", { mailId: mail.id, response, messageCount: members.length });
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

  private async startForward(mail: StoredMail, instruction = "", planId?: number): Promise<void> {
    const existing = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    if (existing?.mode === "forward_recipients") {
      await this.editPrimary(mail, "↪️ منتظر آدرس گیرنده فوروارد هستم…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
      return;
    }
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_recipients", false, "formal", undefined,
      { kind: "forward", ...(instruction ? { instruction } : {}), ...(planId ? { planId } : {}) });
    const prompt = await this.telegram.sendMessage("آدرس ایمیل گیرنده را وارد کنید. برای چند گیرنده، آدرس‌ها را با ویرگول جدا کنید:", undefined, false, true);
    this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
    this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
    await this.editPrimary(mail, "↪️ منتظر آدرس گیرنده فوروارد هستم…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
  }

  private async handleText(message: TelegramMessage): Promise<void> {
    const command = message.text?.trim().toLowerCase().split(/\s+/)[0]?.split("@")[0];
    if (command === "/status") {
      const status = this.status();
      await this.sendCommandResult(message, [
        `<b>وضعیت MailBot</b>`,
        `IMAP: ${status.imapConnected ? "✅ متصل" : "❌ قطع"}`,
        `Inbox: ${status.inboxCount}`,
        `کارت‌های Pending: ${status.pendingThreads}`,
        `پیام‌های Pending: ${status.pending}`,
        `Failed: ${status.failed}`,
        ...Object.entries(status.accounts as Record<string, any>).map(([id, account]) => `${esc(account.label ?? id)}: ${account.imapConnected ? "✅" : "❌"} — ${this.renderImapMode(account.imap)} — Inbox ${account.inboxCount} — Sync ${esc(String(account.lastSuccessfulSync ?? "نامشخص"))}`),
        `آخرین Telegram Poll: ${esc(String(status.lastTelegramPoll ?? "نامشخص"))}`
      ].join("\n"));
      return;
    }
    if (command === "/sync") {
      await this.syncInbox(true);
      const status = this.status();
      await this.sendCommandResult(message, `✅ همگام‌سازی انجام شد.\nInbox: ${status.inboxCount}\nکارت‌های Pending: ${status.pendingThreads}`);
      return;
    }
    if (command === "/accounts") {
      const accounts = this.status().accounts as Record<string, any>;
      await this.sendCommandResult(message, ["<b>حساب‌های ایمیل</b>", ...Object.entries(accounts).map(([id, account]) =>
        `${account.imapConnected ? "✅" : "❌"} ${esc(account.label ?? id)}\nIMAP: ${this.renderImapMode(account.imap)} — Inbox ${account.inboxCount}\nSMTP: ${account.smtp?.ok ? "✅ سالم" : account.smtp?.ok === false ? "❌ خطا" : "⚪ بررسی نشده"}`
      )].join("\n"));
      return;
    }
    if (command === "/failed") {
      const failures = this.store.failureSummary();
      await this.sendCommandResult(message, failures.length ? ["<b>عملیات ناموفق</b>", ...failures.map((item) =>
        `• ${item.kind === "mail" ? "ایمیل" : "Job"} #${item.id} — ${esc(item.subject ?? "نامشخص")}\n${esc((item.error ?? "بدون جزئیات").slice(0, 300))}`
      )].join("\n") : "✅ عملیات ناموفق ثبت‌شده‌ای وجود ندارد.");
      return;
    }
    if (command === "/backup") {
      const backup = this.status().backup as Record<string, unknown>;
      await this.sendCommandResult(message, ["<b>نسخه پشتیبان</b>", `محلی: ${esc(String(backup.lastSuccess ?? "ثبت نشده"))}`, `Telegram: ${esc(String(backup.telegramLastSuccess ?? "غیرفعال/ثبت نشده"))}`, ...(backup.lastError ? [`خطا: ${esc(String(backup.lastError))}`] : []), ...(backup.telegramLastError ? [`خطای Telegram: ${esc(String(backup.telegramLastError))}`] : [])].join("\n"));
      return;
    }
    if (command === "/rules") {
      const rendered = this.renderRulesCommand();
      await this.sendCommandResult(message, rendered.text, rendered.buttons);
      return;
    }
    if (command === "/memory") {
      const rendered = this.renderMemoryCommand();
      await this.sendCommandResult(message, rendered.text, rendered.buttons);
      return;
    }
    if (command === "/tasks") {
      const rendered = this.renderTasksCommand();
      await this.sendCommandResult(message, rendered.text, rendered.buttons);
      return;
    }
    if (command === "/automations") {
      const rendered = this.renderAutomationsCommand();
      await this.sendCommandResult(message, rendered.text, rendered.buttons);
      return;
    }
    if (command === "/search") {
      const query = message.text?.trim().replace(/^\/search(?:@[A-Za-z0-9_]+)?\s*/iu, "") ?? "";
      await this.sendCommandResult(message, this.renderSearchResults(query));
      return;
    }
    if (command === "/diagnose") {
      const status = this.status();
      await this.sendCommandResult(message, [
        `<b>گزارش سلامت MailBot</b>`, `Overall: ${status.ok ? "✅" : "❌"}`, `Inbox/Pending: ${status.inboxCount}/${status.pending}`,
        `Telegram: ${(status.telegram as any)?.ok ? "✅" : "❌"}`, `AI: ${Object.values(status.ai as Record<string, any>).some((item) => item.ok) ? "✅" : "❌"}`,
        `STT: ${(status.stt as any)?.ok ? "✅" : "—"}`, `Jobs: ${esc(JSON.stringify(status.jobs))}`,
        `Rules: ${(status.learnedRules as any)?.enabled ?? 0}/${(status.learnedRules as any)?.total ?? 0}`,
        `Backup: ${(status.backup as any)?.lastSuccess ? "✅" : "❌"}`, `آخرین Poll: ${esc(String(status.lastTelegramPoll ?? "نامشخص"))}`
      ].join("\n"));
      return;
    }
    if (command === "/chatid") {
      await this.sendCommandResult(message, `<b>Chat ID:</b> <code>${message.chat.id}</code>`);
      return;
    }
    const promptMessageId = message.reply_to_message?.message_id;
    const conversation = promptMessageId ? this.store.getConversationByPrompt(this.config.TELEGRAM_USER_ID, promptMessageId) : undefined;
    if (!conversation && promptMessageId && message.text?.trim()) {
      const reference = this.store.resolveTelegramMessage(message.chat.id, promptMessageId);
      const referencedMail = reference ? this.store.getMail(reference.mailId) : undefined;
      if (reference?.role === "card" && referencedMail) {
        await this.planAndExecuteCardRequest(message, referencedMail, reference.scopeMailIds);
        return;
      }
    }
    if (!conversation || !["instruction", "voice_instruction", "voice_transcript_edit", "manual_edit", "forward_recipients", "ai_question", "plan_clarification"].includes(conversation.mode)) {
      const active = this.store.getConversation(this.config.TELEGRAM_USER_ID);
      if (active && ["instruction", "voice_instruction", "voice_transcript_edit", "manual_edit", "forward_recipients", "ai_question", "plan_clarification"].includes(active.mode)) {
        await this.telegram.sendMessage("برای جلوگیری از انتخاب ایمیل اشتباه، متن یا Voice را فقط با Reply مستقیم به پیام درخواست ربات ارسال کنید.", undefined, true);
      } else if (message.text?.trim()) {
        await this.handleUnboundText(message);
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
    if (conversation.mode === "plan_clarification") {
      const originalRequest = String(conversation.metadata?.originalRequest ?? "");
      const scopeMailIds = Array.isArray(conversation.metadata?.immutableScopeMailIds)
        ? conversation.metadata.immutableScopeMailIds.filter((id): id is number => typeof id === "number") : [mail.id];
      const previousPlanId = Number(conversation.metadata?.planId ?? 0);
      if (previousPlanId) this.store.finishConversationPlan(previousPlanId, "cancelled");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      await this.planAndExecuteCardRequest(message, mail, scopeMailIds, `${originalRequest}\nتوضیح کاربر: ${message.text}`);
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
      try { draft = await this.ai.draftForward(mail, String(conversation.metadata?.instruction ?? ""), conversation.tone); } catch { /* safe fallback */ }
      const metadata = { ...(conversation.metadata ?? {}), kind: "forward", recipients, draftVersion: 1 };
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

  private async planAndExecuteCardRequest(message: TelegramMessage, mail: StoredMail, scopeMailIds: number[], request = message.text ?? ""): Promise<void> {
    const tracked = this.store.getMail(mail.id) ?? mail;
    this.store.setTelegramMessages(mail.id, [...new Set([...tracked.telegramMessageIds, message.message_id])], tracked.telegramCreatedAt);
    let plan: ConversationPlan;
    try { plan = await this.ai.planConversationRequest(mail, request, scopeMailIds.length); }
    catch { plan = this.fallbackConversationPlan(request); }
    const exclusive = plan.actions.filter((action) => action.kind === "archive" || action.kind === "cancel");
    const drafts = plan.actions.filter((action) => action.kind === "draft_reply" || action.kind === "draft_forward");
    if (!plan.needsClarification && ((exclusive.length && plan.actions.length > 1) || drafts.length > 1)) {
      plan = { summaryFa: "درخواست چندبخشی نیاز به تعیین ترتیب دارد", needsClarification: true,
        clarificationQuestion: "این کارها را به چه ترتیبی انجام دهم؟", actions: [] };
    }
    const planId = this.store.createConversationPlan({ chatId: message.chat.id, messageId: message.message_id, mailId: mail.id,
      requestText: request, scopeMailIds, plan: plan as unknown as Record<string, unknown> });
    if (plan.needsClarification) {
      this.store.finishConversationPlan(planId, "waiting");
      this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "plan_clarification", false, "formal", undefined,
        { planId, originalRequest: request, immutableScopeMailIds: scopeMailIds });
      const prompt = await this.telegram.sendMessage(plan.clarificationQuestion!, undefined, false, true);
      this.store.setConversationPrompt(this.config.TELEGRAM_USER_ID, mail.id, prompt.message_id);
      this.store.setTelegramMessages(mail.id, [...mail.telegramMessageIds, prompt.message_id], mail.telegramCreatedAt);
      this.store.registerTelegramMessage({ chatId: prompt.chat.id, messageId: prompt.message_id, mailId: mail.id, role: "prompt", scopeMailIds });
      await this.cleanupConversationMessages(this.store.getMail(mail.id)!, message.message_id);
      return;
    }
    this.store.finishConversationPlan(planId, "running");
    try {
      for (const [index, action] of plan.actions.entries()) await this.executeConversationAction(planId, index, action, mail, scopeMailIds);
      this.store.finishConversationPlan(planId, "complete");
      await this.cleanupConversationMessages(this.store.getMail(mail.id)!, message.message_id);
    } catch (error) {
      this.store.finishConversationPlan(planId, "failed", describeError(error));
      throw error;
    }
  }

  private async executeConversationAction(planId: number, actionIndex: number, action: ConversationPlanAction, mail: StoredMail, scopeMailIds: number[]): Promise<void> {
    try {
      if (action.kind === "archive") await this.archiveConversationTarget(mail, action.target === "snapshot" ? scopeMailIds : [mail.id]);
      else if (action.kind === "cancel") { this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id); await this.showSummary(mail); }
      else if (action.kind === "ask") {
        const answer = await this.ai.ask(mail, action.question);
        await this.editPrimary(this.store.getMail(mail.id)!, `<b>✨ پاسخ AI</b>\n\n${esc(splitTelegramText(answer, 3400)[0]!)}`, [[
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
        ]]);
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { answer });
        return;
      } else if (action.kind === "draft_reply") {
        const draft = await this.ai.draftReply(mail, action.instruction, action.tone, action.replyAll, await this.imapFor(mail).findThread(mail));
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", action.replyAll, action.tone, draft,
          { kind: "reply", planId, draftVersion: 1 });
        await this.showDraft(mail, draft, action.replyAll);
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { draftVersion: 1, replyAll: action.replyAll });
        return;
      } else if (action.kind === "draft_forward") {
        await this.startForward(mail, action.instruction, planId);
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { awaitingRecipients: true });
        return;
      } else if (action.kind === "remember") {
        const requestText = this.store.getConversationPlan(planId)?.requestText ?? "";
        const explicit = this.isExplicitMemoryStatement(requestText);
        const memory = this.memory.remember({ kind: action.memoryKind, key: action.key,
          statement: explicit ? this.explicitMemoryStatement(requestText) : action.statement,
          scope: action.scope, ...(action.scope === "account" ? { accountId: mail.accountId ?? this.primaryAccountId } : {}),
          confidence: explicit ? "confirmed" : "inferred", source: explicit ? "user" : "model", sourceMailId: mail.id, sourcePlanId: planId });
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { memoryId: memory.id, confidence: memory.confidence });
        await this.editPrimary(mail, explicit
          ? `🧠 یاد گرفتم: ${esc(memory.statement)}`
          : `🧠 این برداشت به‌عنوان فرض تأییدنشده ثبت شد و تا تأیید شما روی تصمیم‌ها اثر نمی‌گذارد: ${esc(memory.statement)}`, [[
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
        ]]);
        return;
      } else if (action.kind === "create_task") {
        const dueAt = action.dueAt ? Date.parse(action.dueAt) : undefined;
        if (action.needsReminder && (!dueAt || Number.isNaN(dueAt))) throw new Error("زمان یادآوری معتبر نیست.");
        const mailIds = action.target === "snapshot" ? scopeMailIds : [mail.id];
        const dedupeKey = createHash("sha256").update(JSON.stringify([mail.accountId, [...mailIds].sort(), action.title.trim().toLowerCase(), dueAt ?? null])).digest("hex");
        const task = this.store.createMailTask({ accountId: mail.accountId ?? this.primaryAccountId, title: action.title,
          state: action.taskState, mailIds, ...(dueAt ? { dueAt } : {}), timezone: this.config.USER_TIMEZONE, dedupeKey });
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { taskId: task.id, reminderState: task.reminderState });
        await this.editPrimary(mail, `🗓 کار #${task.id} ثبت شد: ${esc(task.title)}${task.dueAt ? `\nیادآوری: ${esc(this.formatTaskTime(task.dueAt))}` : ""}`, [[
          { text: "✅ انجام شد", callback_data: `sys:task:${task.id}:done`, style: "success" },
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }
        ]]);
        return;
      } else if (action.kind === "set_automation") {
        const request = this.store.getConversationPlan(planId)?.requestText ?? "";
        if (!/(خودکار|خودت|دیگه ازم نپرس|متوقف|توقف|غیرفعال)/u.test(request)) {
          this.store.appendConversationToolResult(planId, actionIndex, action.kind, "skipped", { reason: "explicit_permission_required" });
          await this.editPrimary(mail, "برای تغییر خودکارسازی باید صریحاً بگویید چه دسته‌ای فعال یا متوقف شود.", [[
            { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
          ]]);
          return;
        }
        const accountId = action.scope === "account" ? mail.accountId ?? this.primaryAccountId : undefined;
        if (action.enabled) this.store.saveAutomationPolicy({ name: `${action.category} — ${action.scope}`, category: action.category,
          action: "archive", scope: action.scope, ...(accountId ? { accountId } : {}), exceptions: action.exceptions, source: "user" });
        else this.store.setAutomationCategoryStatus(action.category, action.scope, accountId, "paused");
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { enabled: action.enabled, mode: this.config.AUTOMATION_MODE });
        await this.editPrimary(mail, `${action.enabled ? "✅ قانون خودکارسازی ثبت شد" : "⏸ خودکارسازی متوقف شد"}. حالت مؤثر سرویس: ${esc(this.effectiveAutomationMode())}`, [[
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
        ]]);
        return;
      } else if (action.kind === "explain_decision") {
        const decision = this.store.latestAutomationDecision(mail.id);
        await this.editPrimary(mail, decision ? `چرا؟ ${esc(decision.reason)}` : "برای این ایمیل تصمیم خودکارسازی ثبت نشده است.", [[
          { text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }
        ]]);
        this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete", { decisionId: decision?.id ?? null });
        return;
      }
      this.store.appendConversationToolResult(planId, actionIndex, action.kind, "complete");
    } catch (error) {
      this.store.appendConversationToolResult(planId, actionIndex, action.kind, "failed", { error: describeError(error) });
      throw error;
    }
  }

  private async archiveConversationTarget(contextMail: StoredMail, requestedIds: number[]): Promise<void> {
    const uniqueIds = [...new Set(requestedIds)];
    const mails = uniqueIds.map((id) => this.store.getMail(id)).filter((mail): mail is StoredMail => Boolean(mail));
    if (mails.length !== uniqueIds.length) throw new Error("بخشی از snapshot ایمیل دیگر در دسترس نیست؛ عملیات انجام نشد.");
    if (mails.some((mail) => mail.accountId !== contextMail.accountId)) throw new Error("عملیات چندحسابی در یک مرحله مجاز نیست.");
    if (mails.every((mail) => mail.state === "done" || mail.state === "external_done")) return;
    const actionable = mails.filter((mail) => mail.state === "pending" || mail.state === "failed");
    if (!actionable.length) throw new Error("ایمیل انتخاب‌شده در وضعیت قابل آرشیو نیست.");
    if (this.config.APP_MODE !== "live") {
      await this.telegram.sendMessage("🧪 حالت آزمایشی فعال است؛ ایمیل جابه‌جا نشد.", undefined, true);
      return;
    }
    for (const mail of actionable) this.store.setState(mail.id, "processing");
    try {
      await this.imapFor(contextMail).archiveMany(actionable);
      for (const mail of actionable) {
        this.store.setState(mail.id, "done");
        this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
        if (mail.telegramMessageIds.length) this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "conversation_archive" });
      }
      await this.processJobs();
      await this.syncInbox(true);
      this.logger.info("Conversational snapshot archived", { accountId: contextMail.accountId, mailIds: actionable.map((mail) => mail.id) });
    } catch (error) {
      for (const mail of actionable) this.store.setState(mail.id, "failed", describeError(error));
      throw error;
    }
  }

  private fallbackConversationPlan(request: string): ConversationPlan {
    const intent = planConversation(request);
    if (intent.kind === "archive" || intent.kind === "cancel") return { summaryFa: "اجرای درخواست روشن کاربر", needsClarification: false,
      actions: [{ kind: intent.kind, target: "this_mail" }] };
    if (intent.kind === "reply") return { summaryFa: "ساخت پیش‌نویس پاسخ", needsClarification: false,
      actions: [{ kind: "draft_reply", target: "this_mail", instruction: request, tone: "formal", replyAll: intent.replyAll }] };
    if (intent.kind === "forward") return { summaryFa: "آماده‌سازی فوروارد", needsClarification: false,
      actions: [{ kind: "draft_forward", target: "this_mail", instruction: request }] };
    return { summaryFa: "پاسخ به پرسش درباره ایمیل", needsClarification: false,
      actions: [{ kind: "ask", target: "this_mail", question: intent.question }] };
  }

  private isExplicitMemoryStatement(text: string): boolean {
    return /(یادت (?:باشه|بماند)|از این به بعد|همیشه|قاعده|قانون|فقط برای|این برداشت.*اشتباه|اصلاحش کن|من .* هستم)/u.test(text);
  }

  private explicitMemoryStatement(text: string): string {
    return text.replace(/^(?:لطفاً\s+)?(?:یادت (?:باشه|بماند)(?:\s+که)?|از این به بعد(?:\s+بدان)?|این قانون(?:\s+را)?(?:\s+ثبت کن)?)[\s:،-]*/u, "").trim().slice(0, 1000) || text.trim().slice(0, 1000);
  }

  private renderMemoryCommand(): { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } {
    const memories = this.store.listMemories(true);
    if (!memories.length) return { text: "🧠 هنوز حافظه ساخت‌یافته‌ای ثبت نشده است.", buttons: [] };
    return {
      text: ["<b>حافظه دستیار</b>", ...memories.slice(0, 20).map((memory) =>
        `${memory.status === "active" ? "✅" : memory.status === "superseded" ? "↪️" : "⏸"} #${memory.id} — ${esc(memory.statement)}\n${memory.scope === "global" ? "همه حساب‌ها" : esc(memory.accountId ?? "حساب")} · ${memory.confidence === "confirmed" ? "تأییدشده" : "استنباطی"}`
      )].join("\n\n"),
      buttons: memories.filter((memory) => memory.status !== "superseded").slice(0, 10).map((memory) => [{
        text: `${memory.status === "active" ? "⏸" : "▶️"} #${memory.id}`,
        callback_data: `sys:memory:${memory.id}:toggle`
      }])
    };
  }

  private async processTaskReminders(): Promise<void> {
    for (let task = this.store.leaseDueReminder(); task; task = this.store.leaseDueReminder()) {
      try {
        const sent = await this.telegram.sendMessage(`⏰ <b>یادآوری کار #${task.id}</b>\n${esc(task.title)}\n${esc(this.formatTaskTime(task.dueAt!))}`, [[
          { text: "✅ انجام شد", callback_data: `sys:task:${task.id}:done`, style: "success" },
          { text: "لغو", callback_data: `sys:task:${task.id}:cancel` }
        ]]);
        this.store.completeReminder(task.id, sent.message_id);
      } catch (error) {
        this.store.failReminder(task.id, describeError(error), Math.min(60_000, 2000 * (2 ** task.attempts)), task.attempts >= 5);
      }
    }
  }

  private renderTasksCommand(): { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } {
    const tasks = this.store.listMailTasks(true);
    if (!tasks.length) return { text: "✅ کار یا یادآوری بازی ندارید.", buttons: [] };
    return { text: ["<b>کارهای باز</b>", ...tasks.map((task) => `#${task.id} — ${esc(task.title)}${task.dueAt ? `\n⏰ ${esc(this.formatTaskTime(task.dueAt))}` : ""}`)].join("\n\n"),
      buttons: tasks.slice(0, 10).map((task) => [
        { text: `✅ #${task.id}`, callback_data: `sys:task:${task.id}:done` },
        { text: "لغو", callback_data: `sys:task:${task.id}:cancel` }
      ]) };
  }

  private formatTaskTime(timestamp: number): string {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short", timeZone: this.config.USER_TIMEZONE }).format(new Date(timestamp));
  }

  private renderAutomationsCommand(): { text: string; buttons: Array<Array<{ text: string; callback_data: string }>> } {
    const policies = this.store.listAutomationPolicies(false);
    return {
      text: [`<b>خودکارسازی — ${esc(this.effectiveAutomationMode())}</b>${this.config.AUTOMATION_MODE === "execute" && this.config.APP_MODE !== "live" ? "\nAPP_MODE آزمایشی است؛ اجرا به مشاهده تنزل یافته است." : ""}`, ...(policies.length ? policies.map((policy) =>
        `${policy.status === "active" ? "✅" : "⏸"} #${policy.id} ${esc(policy.name)}${policy.exceptions.length ? `\nاستثنا: ${esc(policy.exceptions.join("، "))}` : ""}`
      ) : ["هیچ قانونی ثبت نشده است."])].join("\n\n"),
      buttons: policies.slice(0, 10).map((policy) => [{ text: `${policy.status === "active" ? "⏸" : "▶️"} #${policy.id}`, callback_data: `sys:auto:${policy.id}:toggle` }])
    };
  }

  private async handleUnboundText(message: TelegramMessage): Promise<void> {
    const text = message.text!.trim();
    const senderRule = this.parseBulkSenderArchiveRequest(text);
    if (senderRule) {
      await this.previewBulkSenderArchive(message, senderRule);
      return;
    }
    if (this.isBulkCalendarArchiveRequest(text)) {
      await this.previewBulkCalendarArchive(message);
      return;
    }
    const search = /^(?:جستجو|جست‌وجو|پیدا کن)\s+(.+)$/u.exec(text);
    let result: string;
    if (search) result = this.renderSearchResults(search[1]!);
    else if (/(?:کارها|وظایف|پیگیری).*(?:باز|مانده|روی زمین)|چه کارهایی/u.test(text)) result = this.renderTasksCommand().text;
    else if (/(?:چی|چه).*(?:یاد گرفتی|می‌دانی)|حافظه/u.test(text)) result = this.renderMemoryCommand().text;
    else if (/خودکارسازی|قواعد خودکار/u.test(text)) result = this.renderAutomationsCommand().text;
    else result = "پیام شما دریافت شد. برای اقدام یا سؤال درباره یک ایمیل، روی همان کارت Reply مستقیم بزنید. برای جست‌وجو بنویسید «جستجو عبارت»، و برای فهرست‌ها از /tasks، /memory یا /automations استفاده کنید.";
    await this.telegram.sendMessageTo(message.chat.id, result, [[{ text: "✖️ بستن", callback_data: "sys:close" }]], true);
  }

  private isBulkCalendarArchiveRequest(text: string): boolean {
    const normalized = text.trim().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ");
    const archive = /(?:آرشیو|ارشیو|از اینباکس (?:بردار|خارج کن))/u.test(normalized);
    const calendar = /(?:تقویم|تقویمی|کلندر|دعوت(?:‌| )?(?:نامه)?|[جح]لسه)/u.test(normalized);
    const bulk = /(?:همه|تمام|کل|هرچی|هر چه)/u.test(normalized);
    return archive && calendar && bulk;
  }

  private pendingCalendarMails(): StoredMail[] {
    return this.store.listPending().filter((mail) => Boolean(mail.calendar));
  }

  private bulkCalendarButtons(): Array<Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>> {
    return [
      [{ text: "✅ تأیید آرشیو", callback_data: "sys:bulkcal:confirm", style: "danger" }],
      [{ text: "👁 مشاهده موارد", callback_data: "sys:bulkcal:view", style: "primary" },
        { text: "❌ لغو", callback_data: "sys:bulkcal:cancel" }]
    ];
  }

  private async previewBulkCalendarArchive(message: TelegramMessage): Promise<void> {
    const mails = this.pendingCalendarMails();
    if (!mails.length) {
      await this.telegram.sendMessageTo(message.chat.id, "✅ ایمیل تقویمی Pending برای آرشیو پیدا نشد.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]], true);
      return;
    }
    const accounts = new Map<string, { label: string; count: number }>();
    for (const mail of mails) {
      const id = mail.accountId ?? this.primaryAccountId;
      const current = accounts.get(id);
      accounts.set(id, { label: mail.accountLabel ?? id, count: (current?.count ?? 0) + 1 });
    }
    const text = [
      `<b>پیش‌نمایش آرشیو گروهی</b>`,
      `${this.faNumber(mails.length)} ایمیل تقویمی Pending پیدا شد:`,
      ...[...accounts.values()].map((account) => `• ${esc(account.label)}: ${this.faNumber(account.count)}`),
      "",
      "فقط همین snapshot پس از تأیید آرشیو می‌شود؛ ایمیل‌های بعدی وارد عملیات نخواهند شد."
    ].join("\n");
    const sent = await this.telegram.sendMessageTo(message.chat.id, text, this.bulkCalendarButtons(), true);
    this.store.registerTelegramMessage({ chatId: sent.chat.id, messageId: sent.message_id, mailId: mails[0]!.id,
      role: "prompt", scopeMailIds: mails.map((mail) => mail.id) });
  }

  private async showBulkCalendarSnapshot(chatId: number, messageId: number): Promise<void> {
    const reference = this.store.resolveTelegramMessage(chatId, messageId);
    if (!reference?.active || reference.role !== "prompt") {
      await this.telegram.editMessage(messageId, "این پیش‌نمایش دیگر معتبر نیست.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    const mails = reference.scopeMailIds.map((id) => this.store.getMail(id)).filter((mail): mail is StoredMail => Boolean(mail));
    const items = mails.slice(0, 20).map((mail, index) =>
      `${this.faNumber(index + 1)}. [${esc(mail.accountLabel ?? mail.accountId ?? this.primaryAccountId)}] ${esc(mail.calendar?.summary || mail.subject)}`);
    const remaining = mails.length - items.length;
    await this.telegram.editMessage(messageId, ["<b>دعوت‌ها و ایمیل‌های تقویمی انتخاب‌شده</b>", ...items,
      ...(remaining > 0 ? [`… و ${this.faNumber(remaining)} مورد دیگر`] : [])].join("\n"), this.bulkCalendarButtons());
  }

  private async confirmBulkCalendarArchive(chatId: number, messageId: number): Promise<void> {
    const reference = this.store.resolveTelegramMessage(chatId, messageId);
    if (!reference?.active || reference.role !== "prompt") {
      await this.telegram.editMessage(messageId, "این پیش‌نمایش منقضی یا قبلاً اجرا شده است.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    const resolved = reference.scopeMailIds.map((id) => this.store.getMail(id));
    if (resolved.some((mail) => !mail || !mail.calendar)) {
      this.store.deactivateTelegramMessage(chatId, messageId);
      await this.telegram.editMessage(messageId, "❌ snapshot تغییر کرده یا بخشی از آن در دسترس نیست؛ برای امنیت هیچ ایمیلی آرشیو نشد.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    const actionable = resolved.filter((mail): mail is StoredMail => Boolean(mail && (mail.state === "pending" || mail.state === "failed")));
    if (!actionable.length) {
      this.store.deactivateTelegramMessage(chatId, messageId);
      await this.telegram.editMessage(messageId, "✅ همه موارد این snapshot قبلاً از Inbox خارج شده‌اند.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    if (this.config.APP_MODE !== "live") {
      await this.telegram.editMessage(messageId, "🧪 حالت آزمایشی فعال است؛ هیچ ایمیلی جابه‌جا نشد.", this.bulkCalendarButtons());
      return;
    }
    this.store.deactivateTelegramMessage(chatId, messageId);
    await this.telegram.editMessage(messageId, `⏳ در حال آرشیو ${this.faNumber(actionable.length)} ایمیل تقویمی…`, []);
    const groups = new Map<string, StoredMail[]>();
    for (const mail of actionable) {
      const accountId = mail.accountId ?? this.primaryAccountId;
      groups.set(accountId, [...(groups.get(accountId) ?? []), mail]);
    }
    let archived = 0;
    const failures: string[] = [];
    for (const mails of groups.values()) {
      for (const mail of mails) this.store.setState(mail.id, "processing");
      try {
        await this.imapFor(mails[0]!).archiveMany(mails);
        for (const mail of mails) {
          this.store.setState(mail.id, "done");
          this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
          if (mail.telegramMessageIds.length) this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "bulk_calendar_archive" });
        }
        archived += mails.length;
      } catch (error) {
        const reason = describeError(error);
        for (const mail of mails) this.store.setState(mail.id, "failed", reason);
        failures.push(`${mails[0]!.accountLabel ?? mails[0]!.accountId ?? this.primaryAccountId}: ${reason}`);
      }
    }
    await this.processJobs();
    await this.syncInbox(true);
    this.logger.info("Bulk calendar snapshot archive completed", { requested: actionable.length, archived, failedAccounts: failures.length });
    const result = failures.length
      ? [`⚠️ ${this.faNumber(archived)} ایمیل آرشیو شد.`, "موارد ناموفق:", ...failures.map((failure) => `• ${esc(failure)}`)].join("\n")
      : `✅ ${this.faNumber(archived)} ایمیل تقویمی آرشیو و کارت‌های مرتبط پاک شدند.`;
    await this.telegram.editMessage(messageId, result, [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
  }

  private faNumber(value: number): string {
    return new Intl.NumberFormat("fa-IR", { useGrouping: false }).format(value);
  }

  private parseBulkSenderArchiveRequest(text: string): string | undefined {
    const normalized = text.trim().replace(/ي/g, "ی").replace(/ك/g, "ک");
    const address = normalized.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0]?.toLowerCase();
    const archive = /(?:آرشیو|ارشیو|از اینباکس (?:بردار|خارج کن))/u.test(normalized);
    const future = /(?:از این به بعد|همیشه|بعد از این|در آینده|باید .*آرشیو|باید .*ارشیو)/u.test(normalized);
    return address && archive && future ? address : undefined;
  }

  private senderArchiveButtons(): Array<Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>> {
    return [
      [{ text: "✅ آرشیو فعلی‌ها و فعال‌سازی قانون", callback_data: "sys:bulksender:confirm", style: "danger" }],
      [{ text: "👁 مشاهده موارد فعلی", callback_data: "sys:bulksender:view", style: "primary" },
        { text: "❌ لغو", callback_data: "sys:bulksender:cancel" }]
    ];
  }

  private senderMatches(mail: StoredMail, senderAddress: string): boolean {
    const target = senderAddress.trim().toLowerCase();
    return mail.from.some((sender) => sender.address.trim().toLowerCase() === target);
  }

  private async previewBulkSenderArchive(message: TelegramMessage, senderAddress: string): Promise<void> {
    const mails = this.store.listPending().filter((mail) => this.senderMatches(mail, senderAddress));
    const accounts = new Map<string, { label: string; count: number }>();
    for (const mail of mails) {
      const id = mail.accountId ?? this.primaryAccountId;
      const current = accounts.get(id);
      accounts.set(id, { label: mail.accountLabel ?? id, count: (current?.count ?? 0) + 1 });
    }
    const text = ["<b>پیش‌نمایش قانون فرستنده</b>", `<b>آدرس دقیق:</b> <code>${esc(senderAddress)}</code>`,
      `ایمیل‌های Pending فعلی: ${this.faNumber(mails.length)}`,
      ...[...accounts.values()].map((account) => `• ${esc(account.label)}: ${this.faNumber(account.count)}`), "",
      "پس از تأیید، فقط همین snapshot آرشیو می‌شود و یک قانون سراسری برای آرشیو خودکار تمام ایمیل‌های آینده از همین آدرس دقیق فعال خواهد شد؛ امتیاز اهمیت AI مانع اجرای این قانون صریح نمی‌شود."
    ].join("\n");
    const sent = await this.telegram.sendMessageTo(message.chat.id, text, this.senderArchiveButtons(), true);
    this.store.createPendingBulkAction({ chatId: sent.chat.id, messageId: sent.message_id, kind: "archive_sender_and_rule",
      criteria: { senderAddress }, mailIds: mails.map((mail) => mail.id) });
    await this.telegram.deleteMessages([message.message_id]).catch(() => false);
  }

  private async showBulkSenderSnapshot(chatId: number, messageId: number): Promise<void> {
    const action = this.store.getPendingBulkAction(chatId, messageId);
    if (!action || action.state !== "pending") {
      await this.telegram.editMessage(messageId, "این پیش‌نمایش دیگر معتبر نیست.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    const mails = action.mailIds.map((id) => this.store.getMail(id)).filter((mail): mail is StoredMail => Boolean(mail));
    const items = mails.slice(0, 20).map((mail, index) =>
      `${this.faNumber(index + 1)}. [${esc(mail.accountLabel ?? mail.accountId ?? this.primaryAccountId)}] ${esc(mail.subject)}`);
    await this.telegram.editMessage(messageId, [
      `<b>ایمیل‌های فعلی از ${esc(action.criteria.senderAddress)}</b>`,
      ...(items.length ? items : ["مورد Pending فعلی وجود ندارد؛ فقط قانون آینده فعال خواهد شد."]),
      ...(mails.length > items.length ? [`… و ${this.faNumber(mails.length - items.length)} مورد دیگر`] : [])
    ].join("\n"), this.senderArchiveButtons());
  }

  private async confirmBulkSenderArchive(chatId: number, messageId: number): Promise<void> {
    const action = this.store.getPendingBulkAction(chatId, messageId);
    if (!action || action.state !== "pending") {
      await this.telegram.editMessage(messageId, "این پیش‌نمایش منقضی یا قبلاً اجرا شده است.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    const resolved = action.mailIds.map((id) => this.store.getMail(id));
    if (resolved.some((mail) => !mail || !this.senderMatches(mail, action.criteria.senderAddress))) {
      this.store.finishPendingBulkAction(action.id, "failed", "snapshot validation failed");
      await this.telegram.editMessage(messageId, "❌ snapshot تغییر کرده است؛ هیچ ایمیلی آرشیو و هیچ قانونی فعال نشد.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    if (this.config.APP_MODE !== "live") {
      await this.telegram.editMessage(messageId, "🧪 حالت آزمایشی فعال است؛ ایمیل یا قانون تغییر نکرد.", this.senderArchiveButtons());
      return;
    }
    const actionable = resolved.filter((mail): mail is StoredMail => Boolean(mail && (mail.state === "pending" || mail.state === "failed")));
    await this.telegram.editMessage(messageId, `⏳ در حال آرشیو ${this.faNumber(actionable.length)} ایمیل و ثبت قانون فرستنده…`, []);
    const groups = new Map<string, StoredMail[]>();
    for (const mail of actionable) {
      const accountId = mail.accountId ?? this.primaryAccountId;
      groups.set(accountId, [...(groups.get(accountId) ?? []), mail]);
    }
    let archived = 0;
    const failures: string[] = [];
    for (const mails of groups.values()) {
      for (const mail of mails) this.store.setState(mail.id, "processing");
      try {
        await this.imapFor(mails[0]!).archiveMany(mails);
        for (const mail of mails) {
          this.store.setState(mail.id, "done");
          this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
          if (mail.telegramMessageIds.length) this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "bulk_sender_archive" });
        }
        archived += mails.length;
      } catch (error) {
        const reason = describeError(error);
        for (const mail of mails) this.store.setState(mail.id, "failed", reason);
        failures.push(`${mails[0]!.accountLabel ?? mails[0]!.accountId ?? this.primaryAccountId}: ${reason}`);
      }
    }
    if (failures.length) {
      this.store.finishPendingBulkAction(action.id, "failed", failures.join(" | "));
      await this.processJobs();
      await this.syncInbox(true);
      await this.telegram.editMessage(messageId, [`⚠️ ${this.faNumber(archived)} ایمیل آرشیو شد، اما قانون آینده به‌دلیل شکست بخشی از snapshot فعال نشد.`,
        ...failures.map((failure) => `• ${esc(failure)}`)].join("\n"), [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
      return;
    }
    const existing = this.store.findAutomationPolicyBySender(action.criteria.senderAddress);
    const policy = existing ?? this.store.saveAutomationPolicy({ name: `فرستنده ${action.criteria.senderAddress}`,
      category: "informational", action: "archive", scope: "global", exceptions: [], source: "user",
      senderAddress: action.criteria.senderAddress });
    this.store.finishPendingBulkAction(action.id, "complete");
    await this.processJobs();
    await this.syncInbox(true);
    this.logger.info("Exact-sender archive rule confirmed", { senderAddress: action.criteria.senderAddress, archived, policyId: policy.id });
    await this.telegram.editMessage(messageId, `✅ ${this.faNumber(archived)} ایمیل فعلی آرشیو شد و قانون آینده برای ${esc(action.criteria.senderAddress)} فعال شد.`,
      [[{ text: "✖️ بستن", callback_data: "sys:close" }]]);
  }

  private renderSearchResults(query: string): string {
    const value = query.trim();
    if (value.length < 2) return "عبارت جست‌وجو را بعد از /search یا واژه «جستجو» بنویسید.";
    const results = this.store.searchMails(value, 5);
    if (!results.length) return `برای «${esc(value.slice(0, 100))}» نتیجه‌ای در داده‌های نگه‌داری‌شده پیدا نشد.`;
    return [`<b>نتیجه جست‌وجو: ${esc(value.slice(0, 100))}</b>`, ...results.map((mail) =>
      `${mail.state === "pending" || mail.state === "failed" || mail.state === "processing" ? "📥" : "📁"} <b>#${mail.id}</b> [${esc(mail.accountLabel ?? mail.accountId ?? this.primaryAccountId)}]\n${esc(mail.subject)}\nاز: ${esc(mail.from[0]?.name || mail.from[0]?.address || "نامشخص")}`
    )].join("\n\n");
  }

  private automationActivationKey(): string { return `automation:${this.effectiveAutomationMode()}:activated-at`; }
  private effectiveAutomationMode(): "off" | "observe" | "execute" {
    return this.config.AUTOMATION_MODE === "execute" && this.config.APP_MODE !== "live" ? "observe" : this.config.AUTOMATION_MODE;
  }

  private renderImapMode(status?: { connectionState?: string; notificationMode?: string }): string {
    if (status?.connectionState === "reconnecting") return "🔄 اتصال مجدد";
    if (status?.connectionState === "connecting") return "⏳ در حال اتصال";
    if (status?.notificationMode === "idle") return "⚡ IDLE فعال";
    if (status?.notificationMode === "idle-pending") return "🟢 متصل؛ IDLE در انتظار";
    if (status?.notificationMode === "polling-fallback") return "🔁 Polling fallback";
    return "❌ قطع";
  }

  private async sendCommandResult(command: TelegramMessage, text: string, buttons?: Array<Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>>): Promise<void> {
    await this.telegram.sendMessageTo(command.chat.id, text, buttons ?? [[{ text: "✖️ بستن", callback_data: "sys:close" }]], true);
    await this.telegram.deleteMessages([command.message_id]).catch(() => false);
  }

  private async extractAttachmentContext(mail: StoredMail): Promise<string> {
    const sections: string[] = [];
    let remaining = this.config.AI_CONTEXT_MAX_CHARS;
    const attachments = this.store.threadMembers(mail.id).flatMap((member) => member.attachments
      .filter((item) => item.isRealAttachment).map((attachment) => ({ member, attachment })));
    for (const { member, attachment } of attachments) {
      if (remaining <= 0) break;
      if (!canExtractAttachment(attachment.filename, attachment.contentType)) {
        sections.push(`FILE: ${attachment.filename}\n[نوع فایل برای استخراج متن پشتیبانی نمی‌شود]`); continue;
      }
      if (attachment.size > this.config.AI_ATTACHMENT_MAX_BYTES) {
        sections.push(`FILE: ${attachment.filename}\n[فایل از محدودیت تحلیل ${this.config.AI_ATTACHMENT_MAX_BYTES} بایت بزرگ‌تر است]`); continue;
      }
      try {
        const content = await this.imapFor(member).fetchAttachment(member, attachment);
        const extracted = await extractAttachmentText(attachment.filename, attachment.contentType, content);
        const text = extracted?.slice(0, remaining);
        sections.push(text ? `EMAIL: ${member.subject}\nFILE: ${attachment.filename}\n${text}` : `FILE: ${attachment.filename}\n[نوع فایل برای استخراج متن پشتیبانی نمی‌شود]`);
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
    const current = this.store.getMail(mail.id) ?? mail;
    const primary = current.telegramMessageIds.slice(0, 1);
    const auxiliary = [...new Set([...current.telegramMessageIds.slice(1), incomingMessageId])];
    if (!auxiliary.length) return;
    let deleted = false;
    try { deleted = await this.telegram.deleteMessages(auxiliary); }
    catch (error) {
      this.logger.warn("Conversation message cleanup deferred", { mailId: mail.id, messageCount: auxiliary.length, error: describeError(error) });
    }
    this.store.setTelegramMessages(mail.id, deleted ? primary : [...new Set([...primary, ...auxiliary])], current.telegramCreatedAt);
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

  private async showForwardDraft(mail: StoredMail, draft: string, recipients: string[], voiceTranscript?: string, notice?: string): Promise<void> {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const approvalToken = this.draftApprovalToken(mail, draft, false, conversation?.metadata);
    await this.editPrimary(mail, `${notice ? `${esc(notice)}\n\n` : ""}<b>پیش‌نویس متن همراه فوروارد</b>\n<b>گیرندگان:</b> ${esc(recipients.join(", "))}\n<b>پیوست‌ها:</b> ${mail.attachments.filter((item) => item.isRealAttachment).length}${this.renderVoiceTranscript(voiceTranscript)}\n\n<b>متن نهایی:</b>\n${esc(draft)}`, [[
      { text: "✅ ارسال نهایی", callback_data: `m:${mail.id}:send:${approvalToken}`, style: "success" },
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

  private async showDraft(mail: StoredMail, draft: string, replyAll: boolean, voiceTranscript?: string, notice?: string): Promise<void> {
    const primary = mail.replyTo.length ? mail.replyTo : mail.from;
    const excluded = new Set([...this.ownAddresses().map((address) => address.toLowerCase()), ...primary.map((a) => a.address.toLowerCase())]);
    const seen = new Set<string>();
    const copies = replyAll ? [...mail.to, ...mail.cc].filter((a) => {
      const key = a.address.toLowerCase();
      if (excluded.has(key) || seen.has(key)) return false;
      seen.add(key); return true;
    }) : [];
    const recipients = [...primary, ...copies].map((a) => a.address).join(", ");
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID, mail.id);
    const approvalToken = this.draftApprovalToken(mail, draft, replyAll, conversation?.metadata);
    await this.editPrimary(mail, `${notice ? `${esc(notice)}\n\n` : ""}<b>پیش‌نویس پاسخ AI</b>\n<b>گیرندگان:</b> ${esc(recipients)}${this.renderVoiceTranscript(voiceTranscript)}\n\n<b>متن نهایی:</b>\n${esc(draft)}`, [[
      { text: "✅ ارسال نهایی", callback_data: `m:${mail.id}:send:${approvalToken}`, style: "success" },
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

  private draftApprovalToken(mail: StoredMail, draft: string, replyAll: boolean, metadata?: Record<string, unknown>): string {
    const recipients = metadata?.kind === "forward" ? this.forwardRecipients(metadata) : [];
    return createHash("sha256").update(JSON.stringify({ mailId: mail.id, accountId: mail.accountId ?? this.primaryAccountId,
      draft, replyAll, kind: metadata?.kind ?? "reply", recipients })).digest("hex").slice(0, 12);
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
      this.store.setThreadState(mail.id, "done");
      this.store.markOutbound(mail.id, "complete");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "reply_complete" });
      await this.processJobs();
      this.logger.info("Reply sent, saved to Sent, and mail archived; Telegram cleanup queued", { mailId: mail.id, replyAll: conversation.replyAll });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      const token = this.draftApprovalToken(mail, conversation.draft, conversation.replyAll, conversation.metadata);
      await this.editPrimary(mail, `${replySent ? `⚠️ پاسخ ارسال شد، اما مرحله ${retryStep} ناموفق بود. پاسخ دوباره ارسال نمی‌شود.` : "❌ پاسخ ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, replySent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send:${token}`, style: "primary" }]] : [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
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
      this.store.setThreadState(mail.id, "done");
      this.store.markOutbound(mail.id, "complete");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID, mail.id);
      this.store.enqueueJob("telegram_cleanup", mail.id, { reason: "forward_complete" });
      await this.processJobs();
      this.logger.info("Mail forwarded with attachments, saved to Sent, and archived; Telegram cleanup queued", { mailId: mail.id, recipientCount: recipients.length });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      const token = this.draftApprovalToken(mail, conversation.draft, false, conversation.metadata);
      await this.editPrimary(mail, `${forwardSent ? `⚠️ فوروارد ارسال شد، اما مرحله ${retryStep} ناموفق بود. ایمیل دوباره ارسال نمی‌شود.` : "❌ فوروارد ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, forwardSent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send:${token}`, style: "primary" }]] : [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary`, style: "primary" }]]);
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
