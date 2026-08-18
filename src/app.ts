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

export class MailBotApp {
  private syncRunning = false;
  private stopping = false;
  private readonly aiInFlight = new Set<number>();
  constructor(
    private config: AppConfig, private store: Store, private imap: ImapService,
    private smtp: SmtpService, private telegram: TelegramApi, private ai: AiService, private logger: Logger
  ) {}

  async start(): Promise<void> {
    await this.imap.connect();
    await this.syncInbox(this.config.TELEGRAM_INITIAL_IMPORT_SILENT);
    void this.pollTelegram();
    void this.imap.waitForChanges(() => this.syncInbox(false));
    setInterval(() => void this.syncInbox(false), this.config.IMAP_RECONCILE_SECONDS * 1000).unref();
    setInterval(() => void this.rotatePending(), 60 * 60 * 1000).unref();
  }

  async stop(): Promise<void> { this.stopping = true; await this.imap.stop(); }

  async syncInbox(silent: boolean): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    try {
      const newMail: StoredMail[] = [];
      for (const incoming of await this.imap.scanInbox()) {
        const result = this.store.upsertMail(incoming);
        if (!result.created) {
          const existing = this.store.getMail(result.id)!;
          if (!existing.telegramMessageIds.length) await this.publish(existing, silent);
          continue;
        }
        const mail = this.store.getMail(result.id)!;
        await this.publish(mail, silent);
        newMail.push(mail);
      }
      const analysisTargets = this.store.listPending().filter((mail) => !mail.analysis && !this.aiInFlight.has(mail.id));
      analysisTargets.forEach((mail) => this.aiInFlight.add(mail.id));
      void this.mapConcurrent(analysisTargets, 3, async (mail) => {
        try {
          const analysis = await this.ai.analyze(mail);
          if (!analysis) return;
          this.store.setAnalysis(mail.id, analysis);
          await this.enrichTelegram(this.store.getMail(mail.id)!);
        } finally { this.aiInFlight.delete(mail.id); }
      }).catch((error) => this.logger.warn("Background AI analysis failed", { error: error instanceof Error ? error.message : String(error) }));
    } catch (error) {
      this.logger.error("Inbox reconciliation failed", { error: error instanceof Error ? error.message : String(error) });
    } finally { this.syncRunning = false; }
  }

  private async mapConcurrent<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const item = items[cursor++];
        if (item !== undefined) await worker(item);
      }
    }));
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
    for (const mail of pending) await this.telegram.deleteMessages(mail.telegramMessageIds).catch(() => false);
    for (const mail of pending) await this.publish(mail, true);
    this.logger.info("Pending Telegram queue rotated", { count: pending.length });
  }

  private async pollTelegram(): Promise<void> {
    let offset = Number(this.store.getKv("telegram_offset") ?? 0);
    while (!this.stopping) {
      try {
        const updates = await this.telegram.getUpdates(offset);
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
    const match = /^m:(\d+):(summary|body(?::\d+)?|files|done|reply|replyall|forward|instruct|edit|formal|short|friendly|send|cancel)$/.exec(data);
    if (!match) return;
    const mail = this.store.getMail(Number(match[1]));
    if (!mail) { await this.telegram.answerCallbackQuery(callbackId, "ایمیل پیدا نشد"); return; }
    await this.telegram.answerCallbackQuery(callbackId);
    const action = match[2];
    this.logger.info("Telegram action received", { mailId: mail.id, action });
    if (action === "summary") return this.showSummary(mail);
    if (action?.startsWith("body")) return this.showBody(mail, Number(action.split(":")[1] ?? 0));
    if (action === "files") return this.showFiles(mail);
    if (action === "done") return this.done(mail);
    if (action === "reply" || action === "replyall") return this.startReply(mail, action === "replyall");
    if (action === "forward") return this.startForward(mail);
    if (action === "instruct" || action === "edit") {
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID);
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
      const current = this.store.getConversation(this.config.TELEGRAM_USER_ID);
      return current?.metadata?.kind === "forward" ? this.sendForward(mail) : this.sendReply(mail);
    }
    this.store.clearConversation(this.config.TELEGRAM_USER_ID);
    await this.showSummary(mail);
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

  private async showSummary(mail: StoredMail): Promise<void> {
    const current = this.store.getMail(mail.id) ?? mail;
    const auxiliary = current.telegramMessageIds.slice(1);
    if (auxiliary.length) await this.telegram.deleteMessages(auxiliary).catch(() => false);
    this.store.setTelegramMessages(mail.id, current.telegramMessageIds.slice(0, 1), current.telegramCreatedAt);
    this.store.clearConversation(this.config.TELEGRAM_USER_ID);
    await this.editPrimary(this.store.getMail(mail.id)!, renderMail(this.store.getMail(mail.id)!), mailButtons(this.store.getMail(mail.id)!));
  }

  private async editPrimary(mail: StoredMail, text: string, buttons: Parameters<TelegramApi["editMessage"]>[2]): Promise<void> {
    const primaryId = mail.telegramMessageIds[0];
    if (!primaryId) throw new Error("Primary Telegram message is missing");
    await this.telegram.editMessage(primaryId, text, buttons);
  }

  private async done(mail: StoredMail): Promise<void> {
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
  }

  private async startReply(mail: StoredMail, replyAll: boolean): Promise<void> {
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "draft", replyAll);
    await this.editPrimary(mail, "✨ در حال آماده‌سازی پاسخ پیشنهادی AI…", [[{ text: "↩️ بازگشت", callback_data: `m:${mail.id}:summary` }]]);
    try {
      const draft = await this.ai.draftReply(mail, "", "formal", replyAll);
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
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID);
    if (!conversation || !["instruction", "manual_edit", "forward_recipients"].includes(conversation.mode)) return;
    const mail = this.store.getMail(conversation.mailId);
    if (!mail) return;
    if (conversation.mode === "forward_recipients") {
      const recipients = this.parseRecipients(message.text!);
      if (!recipients.length) {
        await this.telegram.sendMessage("❌ آدرس معتبر پیدا نشد. نمونه: colleague@example.com", undefined, true);
        return;
      }
      let draft = "جهت بررسی و اقدام ارسال می‌شود.";
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
        : await this.ai.draftReply(mail, message.text!, conversation.tone, conversation.replyAll);
    this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "review", conversation.replyAll, conversation.tone, draft, conversation.metadata);
    await this.cleanupConversationMessages(mail, message.message_id);
    if (isForward) await this.showForwardDraft(mail, draft, this.forwardRecipients(conversation.metadata));
    else await this.showDraft(mail, draft, conversation.replyAll);
  }

  private async cleanupConversationMessages(mail: StoredMail, incomingMessageId: number): Promise<void> {
    const auxiliary = [...mail.telegramMessageIds.slice(1), incomingMessageId];
    if (auxiliary.length) await this.telegram.deleteMessages(auxiliary).catch(() => false);
    this.store.setTelegramMessages(mail.id, mail.telegramMessageIds.slice(0, 1), mail.telegramCreatedAt);
  }

  private async changeTone(mail: StoredMail, tone: "formal" | "short" | "friendly"): Promise<void> {
    const current = this.store.getConversation(this.config.TELEGRAM_USER_ID);
    if (!current || current.mailId !== mail.id) return;
    const isForward = current.metadata?.kind === "forward";
    const draft = isForward ? await this.ai.draftForward(mail, "", tone) : await this.ai.draftReply(mail, "", tone, current.replyAll);
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
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID);
    if (!conversation?.draft || conversation.mailId !== mail.id) throw new Error("Reply draft is missing");
    const draft = buildReply(mail, conversation.draft, conversation.replyAll, this.config.SMTP_FROM);
    let replySent = conversation.mode === "sent_pending_sentcopy" || conversation.mode === "sent_pending_archive";
    let sentCopySaved = conversation.mode === "sent_pending_archive";
    try {
      let raw = await this.smtp.buildReply(mail, draft);
      if (!replySent) {
        raw = await this.smtp.sendReply(mail, draft);
        replySent = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "sent_pending_sentcopy", conversation.replyAll, conversation.tone, conversation.draft);
      }
      if (!sentCopySaved) {
        await this.imap.appendSent(raw);
        sentCopySaved = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "sent_pending_archive", conversation.replyAll, conversation.tone, conversation.draft);
      }
      await this.imap.archive(mail);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setState(mail.id, "done");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID);
      this.logger.info("Reply sent, saved to Sent, mail archived and Telegram cleaned", { mailId: mail.id, replyAll: conversation.replyAll });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      await this.telegram.sendMessage(`${replySent ? `⚠️ پاسخ ارسال شد، اما مرحله ${retryStep} ناموفق بود. پاسخ دوباره ارسال نمی‌شود.` : "❌ پاسخ ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, replySent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send`, style: "primary" }]] : undefined);
    }
  }

  private async sendForward(mail: StoredMail): Promise<void> {
    const conversation = this.store.getConversation(this.config.TELEGRAM_USER_ID);
    if (!conversation?.draft || conversation.mailId !== mail.id) throw new Error("Forward draft is missing");
    const recipients = this.forwardRecipients(conversation.metadata);
    let forwardSent = conversation.mode === "forward_sent_pending_sentcopy" || conversation.mode === "forward_sent_pending_archive";
    let sentCopySaved = conversation.mode === "forward_sent_pending_archive";
    try {
      const source = await this.imap.fetchSource(mail);
      let raw = await this.smtp.buildForward(mail, recipients, conversation.draft, source);
      if (!forwardSent) {
        raw = await this.smtp.sendForward(mail, recipients, conversation.draft, source);
        forwardSent = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_sent_pending_sentcopy", false, conversation.tone, conversation.draft, conversation.metadata);
      }
      if (!sentCopySaved) {
        await this.imap.appendSent(raw);
        sentCopySaved = true;
        this.store.setConversation(this.config.TELEGRAM_USER_ID, mail.id, "forward_sent_pending_archive", false, conversation.tone, conversation.draft, conversation.metadata);
      }
      await this.imap.archive(mail);
      await this.telegram.deleteMessages(mail.telegramMessageIds);
      this.store.setTelegramMessages(mail.id, []);
      this.store.setState(mail.id, "done");
      this.store.clearConversation(this.config.TELEGRAM_USER_ID);
      this.logger.info("Mail forwarded with attachments, saved to Sent, archived and Telegram cleaned", { mailId: mail.id, recipientCount: recipients.length });
    } catch (error) {
      const retryStep = sentCopySaved ? "آرشیو" : "ذخیره در Sent";
      await this.telegram.sendMessage(`${forwardSent ? `⚠️ فوروارد ارسال شد، اما مرحله ${retryStep} ناموفق بود. ایمیل دوباره ارسال نمی‌شود.` : "❌ فوروارد ارسال نشد؛ ایمیل دست‌نخورده باقی ماند."}\n${esc(error instanceof Error ? error.message : String(error))}`, forwardSent ? [[{ text: `🔄 تلاش مجدد برای ${retryStep}`, callback_data: `m:${mail.id}:send`, style: "primary" }]] : undefined);
    }
  }
}
