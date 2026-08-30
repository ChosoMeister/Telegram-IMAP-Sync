import { describe, expect, it, vi } from "vitest";
import { MailBotApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { Logger } from "../src/logger.js";
import { config, incoming } from "./helpers.js";

function setup(archive = vi.fn().mockResolvedValue(undefined)) {
  const isolatedConfig = { ...config, aiProviderOrder: [...config.aiProviderOrder], sttModelOrder: [...config.sttModelOrder] };
  const store = new Store(":memory:");
  const { id } = store.upsertMail(incoming);
  store.setTelegramMessages(id, [100, 101]);
  const telegram = {
    answerCallbackQuery: vi.fn().mockResolvedValue(true), deleteMessages: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 200, chat: { id: 42 } }), editMessage: vi.fn().mockResolvedValue(true),
    sendMessageTo: vi.fn().mockResolvedValue({ message_id: 200, chat: { id: 42 } }),
    sendDocument: vi.fn(), downloadFile: vi.fn().mockResolvedValue({ content: Buffer.from("voice"), filePath: "voice/file_1.ogg" }), getUpdates: vi.fn()
  };
  const imap = {
    archive, archiveMany: vi.fn(async (mails: any[]) => archive(mails[0])), fetchAttachment: vi.fn(), scanInbox: vi.fn().mockResolvedValue([]), connect: vi.fn(), waitForChanges: vi.fn(), stop: vi.fn(),
    findThread: vi.fn().mockResolvedValue([incoming]),
    sentContainsMessageId: vi.fn().mockResolvedValue(false), appendSent: vi.fn().mockResolvedValue(undefined),
    mailboxIdentity: vi.fn().mockReturnValue({ path: incoming.mailbox, uidValidity: incoming.uidValidity }), isConnected: vi.fn().mockReturnValue(true),
    listInboxUids: vi.fn().mockResolvedValue(new Set([incoming.uid]))
  };
  const ai = {
    analyze: vi.fn().mockResolvedValue(undefined), ask: vi.fn().mockResolvedValue("پاسخ آزمایشی"),
    draftReply: vi.fn().mockResolvedValue("پیش‌نویس صوتی"), draftForward: vi.fn().mockResolvedValue("متن فوروارد"),
    reconcileVoiceTranscript: vi.fn().mockResolvedValue({ finalTranscript: "به ایشان بگو unsubscribe را انجام می‌دهم", confidence: 0.92, uncertainTerms: [], rationale: "توافق دو مدل" }),
    status: vi.fn().mockReturnValue({})
  };
  const stt = { transcribe: vi.fn().mockResolvedValue({ candidates: [{ model: "qwen", text: "آن سابسکرایب" }, { model: "whisper", text: "unsubscribe" }], failedModels: [] }), status: vi.fn().mockReturnValue({ ok: true }) };
  const smtp = { status: vi.fn().mockReturnValue({}), verify: vi.fn().mockResolvedValue(undefined), buildReply: vi.fn().mockResolvedValue(Buffer.from("raw")), buildCalendarResponse: vi.fn().mockResolvedValue({ raw: Buffer.from("calendar-raw"), organizer: "organizer@example.com" }), sendRaw: vi.fn().mockResolvedValue(undefined) };
  const app = new MailBotApp(isolatedConfig, store, imap as any, smtp as any, telegram as any, ai as any, new Logger("error"), undefined, [], stt as any);
  return { app, store, telegram, imap, smtp, ai, stt, archive, id };
}

describe("Done transaction", () => {
  it("renders operational commands as dismissible messages and removes the typed command", async () => {
    const s = setup();
    await (s.app as any).handleText({ message_id: 900, chat: { id: 42 }, from: { id: 42 }, text: "/failed" });
    expect(s.telegram.sendMessageTo).toHaveBeenCalledWith(42, "✅ عملیات ناموفق ثبت‌شده‌ای وجود ندارد.", [[{ text: "✖️ بستن", callback_data: "sys:close" }]], true);
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([900]);
    s.store.close();
  });
  it("immediately retries a failed AI analysis from its Telegram button", async () => {
    const s = setup();
    s.store.setAnalysis(s.id, { importance: "normal", score: 0, summaryFa: "failed", suggestedAction: "retry", reason: "outage", provider: "unavailable" });
    s.store.enqueueJob("analyze", s.id);
    const job = s.store.leaseJob()!;
    s.store.failJob(job.id, "provider unavailable", 60_000, true);
    s.ai.analyze.mockResolvedValueOnce({ importance: "high", score: 80, summaryFa: "خلاصه", suggestedAction: "بررسی کنید", reason: "درخواست", provider: "proxy:test" });
    await (s.app as any).handleCallback("retry", `m:${s.id}:retryai`);
    expect(s.ai.analyze).toHaveBeenCalledOnce();
    expect(s.store.getMail(s.id)?.analysis?.provider).toBe("proxy:test");
    expect(s.store.jobCounts()).toMatchObject({ complete: 1 });
    s.store.close();
  });
  it("corrects one analysis, confirms an account-scoped rule, and applies it to future mail", async () => {
    const s = setup();
    s.store.setAnalysis(s.id, { importance: "high", score: 85, summaryFa: "خلاصه", suggestedAction: "بررسی کنید", reason: "درخواست", provider: "proxy:test", actionOwner: "self", riskFa: "تأخیر" });

    await (s.app as any).handleCallback("menu", `m:${s.id}:feedback`);
    await (s.app as any).handleCallback("choice", `m:${s.id}:fbinformational`);
    expect(s.store.getMail(s.id)?.analysis).toMatchObject({ importance: "low", score: 30, category: "informational", userCorrected: true });
    expect(s.store.getMail(s.id)?.analysis?.riskFa).toBeUndefined();

    await (s.app as any).handleCallback("scope", `m:${s.id}:fbsender`);
    expect(s.store.listLearnedRules()).toHaveLength(0);
    await (s.app as any).handleCallback("confirm", `m:${s.id}:fbconfirm`);
    expect(s.store.listLearnedRules()).toHaveLength(1);
    expect(s.store.listLearnedRules()[0]).toMatchObject({ accountId: "primary", scope: "sender", effect: "informational", enabled: true });

    const future = s.store.upsertMail({ ...incoming, uid: 8, messageId: "<future@example.com>" });
    s.store.enqueueJob("analyze", future.id);
    s.ai.analyze.mockResolvedValueOnce({ importance: "critical", score: 98, summaryFa: "جدید", suggestedAction: "فوری", reason: "مدل", provider: "proxy:test", actionOwner: "self", riskFa: "ریسک" });
    await (s.app as any).processJobs();
    expect(s.ai.analyze).toHaveBeenCalledWith(expect.objectContaining({ id: future.id }), expect.stringContaining("informational"));
    expect(s.store.getMail(future.id)?.analysis).toMatchObject({ importance: "low", score: 30, category: "informational", actionOwner: "other" });
    s.store.close();
  });

  it("lists learned rules and toggles them from the operational command", async () => {
    const s = setup();
    const rule = s.store.saveLearnedRule({ accountId: "primary", scope: "sender", senderEmail: "sender@example.com", effect: "not_mine" });
    await (s.app as any).handleText({ message_id: 901, chat: { id: 42 }, from: { id: 42 }, text: "/rules" });
    expect(s.telegram.sendMessageTo).toHaveBeenCalledWith(42, expect.stringContaining(`#${rule.id}`), expect.arrayContaining([
      [{ text: `⏸ غیرفعال #${rule.id}`, callback_data: `sys:rule:${rule.id}:toggle` }]
    ]), true);
    await (s.app as any).handleSystemCallback("toggle", `sys:rule:${rule.id}:toggle`, 200);
    expect(s.store.getLearnedRule(rule.id)?.enabled).toBe(false);
    s.store.close();
  });
  it("archives before deleting Telegram messages", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    await (s.app as any).handleCallback("cb", `m:${s.id}:done`);
    expect(s.archive).toHaveBeenCalledOnce();
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([100, 101]);
    expect(s.store.getMail(s.id)?.state).toBe("done");
    s.store.close();
  });
  it("keeps a completed mail durable when Telegram cleanup fails", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    s.telegram.deleteMessages.mockRejectedValueOnce(new Error("Telegram unavailable"));
    await (s.app as any).handleCallback("cb", `m:${s.id}:done`);
    expect(s.archive).toHaveBeenCalledOnce();
    expect(s.store.getMail(s.id)?.state).toBe("done");
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([100, 101]);
    expect(s.store.jobCounts()).toMatchObject({ queued: 1 });
    s.store.close();
  });
  it("routes an action to the account that received the mail", async () => {
    const s = setup();
    const secondaryArchive = vi.fn().mockResolvedValue(undefined);
    const secondaryImap = { ...s.imap, archiveMany: secondaryArchive };
    (s.app as any).accounts.push({ id: "secondary", label: "Secondary", config: { ...config, SMTP_FROM: "me@secondary.example" }, imap: secondaryImap, smtp: s.smtp });
    const secondary = s.store.upsertMail({ ...incoming, uid: 99, accountId: "secondary", accountLabel: "Secondary" });
    s.store.setTelegramMessages(secondary.id, [300]);
    (s.app as any).config.APP_MODE = "live";
    await (s.app as any).handleCallback("cb-secondary", `m:${secondary.id}:done`);
    expect(secondaryArchive).toHaveBeenCalledOnce();
    expect(s.archive).not.toHaveBeenCalled();
    s.store.close();
  });
  it("keeps Telegram content and marks failure when archive fails", async () => {
    const s = setup(vi.fn().mockRejectedValue(new Error("move failed")));
    (s.app as any).config.APP_MODE = "live";
    await (s.app as any).handleCallback("cb", `m:${s.id}:done`);
    expect(s.telegram.deleteMessages).not.toHaveBeenCalled();
    expect(s.store.getMail(s.id)?.state).toBe("failed");
    s.store.close();
  });
  it("does not mark the mail failed in dry-run mode", async () => {
    const s = setup();
    await (s.app as any).handleCallback("cb", `m:${s.id}:done`);
    expect(s.archive).not.toHaveBeenCalled();
    expect(s.store.getMail(s.id)?.state).toBe("pending");
    s.store.close();
  });
  it("treats repeated Done callbacks as idempotent", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    s.store.setState(s.id, "done");
    await (s.app as any).handleCallback("cb", `m:${s.id}:done`);
    expect(s.archive).not.toHaveBeenCalled();
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith("cb", "این ایمیل قبلاً انجام شده است");
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([100, 101]);
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([]);
    s.store.close();
  });
  it("serializes concurrent Done callbacks with an atomic mail lock", async () => {
    let finish!: () => void;
    const archive = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const s = setup(archive);
    (s.app as any).config.APP_MODE = "live";
    const first = (s.app as any).handleCallback("cb1", `m:${s.id}:done`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = (s.app as any).handleCallback("cb2", `m:${s.id}:done`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(archive).toHaveBeenCalledOnce();
    expect(s.telegram.answerCallbackQuery).toHaveBeenCalledWith("cb2", "عملیات در حال انجام است");
    finish();
    await Promise.all([first, second]);
    s.store.close();
  });
  it("continues an idempotent action when Telegram replays an expired callback after restart", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    s.telegram.answerCallbackQuery.mockRejectedValueOnce(new Error("Telegram answerCallbackQuery: Bad Request: query is too old and response timeout expired or query ID is invalid"));
    await (s.app as any).handleCallback("expired", `m:${s.id}:done`);
    expect(s.archive).toHaveBeenCalledOnce();
    expect(s.store.getMail(s.id)?.state).toBe("done");
    s.store.close();
  });
});

describe("calendar response transaction", () => {
  it("sends, saves, archives, and removes a calendar invitation only after success", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    s.store.upsertMail({ ...incoming, calendar: { parserVersion: 1, method: "REQUEST", uid: "event-1", organizer: { address: "organizer@example.com" }, attendees: [{ address: "me@example.com" }] } });
    await (s.app as any).handleCallback("preview", `m:${s.id}:calaccept`);
    expect(s.smtp.sendRaw).not.toHaveBeenCalled();
    expect(s.telegram.editMessage).toHaveBeenCalledWith(100, expect.stringContaining("تأیید پاسخ تقویم"), expect.any(Array));
    await (s.app as any).handleCallback("confirm", `m:${s.id}:calacceptconfirm`);
    expect(s.smtp.buildCalendarResponse).toHaveBeenCalledWith(expect.objectContaining({ id: s.id }), "accept", expect.any(String));
    expect(s.smtp.sendRaw).toHaveBeenCalledWith(["organizer@example.com"], Buffer.from("calendar-raw"));
    expect(s.imap.appendSent).toHaveBeenCalledWith(Buffer.from("calendar-raw"));
    expect(s.archive).toHaveBeenCalledOnce();
    expect(s.store.getMail(s.id)?.state).toBe("done");
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([100, 101]);
    s.store.close();
  });
});

describe("reply crash-stage recovery", () => {
  it("does not repeat accepted SMTP when Sent APPEND is retried", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    s.store.setConversation(42, s.id, "review", false, "formal", "پاسخ");
    s.imap.appendSent.mockRejectedValueOnce(new Error("append failed")).mockResolvedValueOnce(undefined);
    await (s.app as any).sendReply(s.store.getMail(s.id));
    expect(s.smtp.sendRaw).toHaveBeenCalledOnce();
    expect(s.store.getOutbound(s.id)).toMatchObject({ smtpAccepted: true, sentSaved: false });
    await (s.app as any).sendReply(s.store.getMail(s.id));
    expect(s.smtp.sendRaw).toHaveBeenCalledOnce();
    expect(s.imap.appendSent).toHaveBeenCalledTimes(2);
    expect(s.archive).toHaveBeenCalledOnce();
    expect(s.store.getOutbound(s.id)).toMatchObject({ completed: true });
    s.store.close();
  });

  it("retries only Archive after the sent copy was saved", async () => {
    const archive = vi.fn().mockRejectedValueOnce(new Error("archive failed")).mockResolvedValueOnce(undefined);
    const s = setup(archive);
    (s.app as any).config.APP_MODE = "live";
    s.store.setConversation(42, s.id, "review", false, "formal", "پاسخ");
    await (s.app as any).sendReply(s.store.getMail(s.id));
    expect(s.store.getOutbound(s.id)).toMatchObject({ smtpAccepted: true, sentSaved: true, completed: false });
    await (s.app as any).sendReply(s.store.getMail(s.id));
    expect(s.smtp.sendRaw).toHaveBeenCalledOnce();
    expect(s.imap.appendSent).toHaveBeenCalledOnce();
    expect(archive).toHaveBeenCalledTimes(2);
    expect(s.store.getOutbound(s.id)).toMatchObject({ completed: true });
    s.store.close();
  });
});

describe("pending queue rotation", () => {
  it("republishes the complete queue oldest first when any item expires", async () => {
    const s = setup();
    s.store.setTelegramMessages(s.id, [100], new Date("2026-08-16T00:00:00Z"));
    const newer = s.store.upsertMail({ ...incoming, uid: 8, messageId: "<newer@example.com>", subject: "Newer", receivedAt: new Date("2026-08-18T11:00:00Z") });
    s.store.setTelegramMessages(newer.id, [102], new Date());
    await (s.app as any).rotatePending();
    expect(s.telegram.deleteMessages.mock.calls.map((call: any[]) => call[0])).toEqual([[100], [102]]);
    const rendered = s.telegram.sendMessage.mock.calls.map((call: any[]) => call[0] as string);
    expect(rendered[0]).toContain("Test");
    expect(rendered[1]).toContain("Newer");
    expect(s.telegram.sendMessage.mock.calls.every((call: any[]) => call[2] === true)).toBe(true);
    s.store.close();
  });
});

describe("incremental reconciliation recovery", () => {
  it("marks health stale when Telegram polling has stopped for two minutes", () => {
    const s = setup();
    (s.app as any).lastSuccessfulSync.set("primary", new Date());
    (s.app as any).lastTelegramPoll = new Date(Date.now() - 121_000);
    expect(s.app.isHealthy()).toBe(false);
    (s.app as any).lastTelegramPoll = new Date();
    expect(s.app.isHealthy()).toBe(true);
    s.store.close();
  });

  it("defers reconciliation quietly while IMAP is disconnected", async () => {
    const s = setup();
    s.imap.isConnected.mockReturnValue(false);
    await s.app.syncInbox(false);
    expect(s.imap.scanInbox).not.toHaveBeenCalled();
    expect(s.imap.listInboxUids).not.toHaveBeenCalled();
    s.store.close();
  });

  it("republishes a persisted pending mail whose Telegram delivery was interrupted", async () => {
    const s = setup();
    s.store.setTelegramMessages(s.id, []);
    await s.app.syncInbox(false);
    expect(s.imap.scanInbox).toHaveBeenCalledWith(new Set([incoming.uid]));
    expect(s.telegram.sendMessage).toHaveBeenCalledOnce();
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([200]);
    s.store.close();
  });

  it("removes a Telegram card after an external Inbox move is confirmed twice", async () => {
    const s = setup();
    s.imap.listInboxUids.mockResolvedValue(new Set());
    await s.app.syncInbox(false);
    expect(s.store.getMail(s.id)?.state).toBe("pending");
    await s.app.syncInbox(false);
    expect(s.store.getMail(s.id)?.state).toBe("external_done");

    // Mailbox completion is durable before Telegram cleanup. The queued cleanup
    // can be retried without repeating the external mailbox operation.
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([100, 101]);
    // The fixture's analysis job is still queued; cleanup is the second job.
    expect(s.store.jobCounts()).toMatchObject({ queued: 2 });

    await (s.app as any).processJobs();
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([100, 101]);
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([]);
    s.store.close();
  });
});

describe("single-card navigation", () => {
  it("suppresses a queued duplicate attachment action without adding chat messages", async () => {
    const s = setup();
    s.store.upsertMail({ ...incoming, attachments: [{ id: "a", filename: "invoice.pdf", contentType: "application/pdf", size: 3, disposition: "attachment", isRealAttachment: true }] });
    const mail = s.store.getMail(s.id)!;
    s.imap.fetchAttachment.mockResolvedValue(Buffer.from("pdf"));
    s.telegram.sendDocument.mockResolvedValue({ message_id: 201, chat: { id: 42 } });
    await (s.app as any).showFiles(mail);
    await (s.app as any).showFiles(mail);
    expect(s.telegram.sendDocument).toHaveBeenCalledOnce();
    expect(s.telegram.sendMessage).not.toHaveBeenCalled();
    s.store.close();
  });

  it("renders full body by editing the primary message instead of sending a new one", async () => {
    const s = setup();
    await (s.app as any).showBody(s.store.getMail(s.id), 0);
    expect(s.telegram.editMessage).toHaveBeenCalledWith(100, expect.stringContaining("متن ایمیل"), expect.any(Array));
    expect(s.telegram.sendMessage).not.toHaveBeenCalled();
    s.store.close();
  });

  it("renders every merged Inbox message with sections and pagination on the same card", async () => {
    const s = setup();
    s.store.upsertMail({ ...incoming, uid: 8, messageId: "<reply@example.com>", inReplyTo: incoming.messageId, subject: "Re: Test", text: "Second message", receivedAt: new Date("2026-08-18T11:00:00Z") });
    const representativeId = s.store.threadRepresentative(s.id)!.id;
    s.store.setTelegramMessages(representativeId, [100]);
    const representative = s.store.getMail(representativeId)!;
    await (s.app as any).showAllBodies(representative, 0);
    expect(s.telegram.editMessage).toHaveBeenCalledWith(100, expect.stringContaining("متن همه پیام‌ها — 2 پیام"), expect.any(Array));
    expect(s.telegram.editMessage.mock.calls.at(-1)?.[1]).toContain("Second message");
    s.store.close();
  });

  it("back removes auxiliary messages and restores the primary card", async () => {
    const s = setup();
    await (s.app as any).showSummary(s.store.getMail(s.id));
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([101]);
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([100]);
    expect(s.telegram.editMessage).toHaveBeenCalled();
    s.store.close();
  });

  it("navigating another mail does not clear an existing reply draft", async () => {
    const s = setup();
    s.store.setConversation(42, s.id, "review", false, "formal", "First reply draft");
    const other = s.store.upsertMail({ ...incoming, uid: 8, subject: "Other mail" });
    s.store.setTelegramMessages(other.id, [102]);
    await (s.app as any).showSummary(s.store.getMail(other.id));
    expect(s.store.getConversation(42, s.id)?.draft).toBe("First reply draft");
    s.store.close();
  });

  it("asks AI about the selected mail and renders the answer on the same card", async () => {
    const s = setup();
    await (s.app as any).handleCallback("cb1", `m:${s.id}:askmail`);
    await (s.app as any).handleText({ message_id: 300, chat: { id: 42 }, reply_to_message: { message_id: 200 }, text: "چه کاری لازم است؟", from: { id: 42 } });
    expect((s.app as any).ai.ask).toHaveBeenCalledWith(expect.objectContaining({ id: s.id }), "چه کاری لازم است؟", [], "");
    expect(s.telegram.editMessage).toHaveBeenLastCalledWith(100, expect.stringContaining("پاسخ آزمایشی"), expect.any(Array));
    expect(s.store.getConversation(42, s.id)).toBeUndefined();
    s.store.close();
  });

  it("binds text to the exact ForceReply prompt when two mail forms are open", async () => {
    const s = setup();
    const other = s.store.upsertMail({ ...incoming, uid: 8, messageId: "<other@example.com>", subject: "Other" });
    s.store.setConversation(42, s.id, "ai_question", false, "formal", undefined, { context: "mail" }, 501);
    s.store.setConversation(42, other.id, "ai_question", false, "formal", undefined, { context: "mail" }, 502);
    await (s.app as any).handleText({ message_id: 600, chat: { id: 42 }, reply_to_message: { message_id: 501 }, text: "ایمیل اول چیست؟", from: { id: 42 } });
    expect((s.app as any).ai.ask).toHaveBeenCalledWith(expect.objectContaining({ id: s.id }), "ایمیل اول چیست؟", [], "");
    expect(s.store.getConversation(42, other.id)).toBeDefined();
    s.store.close();
  });

  it("binds Voice to its exact mail and requires transcript approval before drafting", async () => {
    const s = setup();
    (s.app as any).config.VOICE_REPLY_ENABLED = true;
    s.store.setConversation(42, s.id, "voice_instruction", false, "formal", "old draft", undefined, 501);
    await (s.app as any).handleText({
      message_id: 601, chat: { id: 42 }, reply_to_message: { message_id: 501 }, from: { id: 42 },
      voice: { file_id: "voice-file", file_unique_id: "voice-unique", duration: 12, file_size: 5000, mime_type: "audio/ogg" }
    });
    expect(s.telegram.downloadFile).toHaveBeenCalledWith("voice-file", 10_000_000);
    expect(s.stt.transcribe).toHaveBeenCalledWith(Buffer.from("voice"), "voice.ogg");
    expect(s.ai.reconcileVoiceTranscript).toHaveBeenCalledWith(expect.objectContaining({ id: s.id }), expect.arrayContaining([
      { model: "qwen", text: "آن سابسکرایب" }, { model: "whisper", text: "unsubscribe" }
    ]));
    expect(s.ai.draftReply).not.toHaveBeenCalled();
    expect(s.store.getConversation(42, s.id)).toMatchObject({ mode: "voice_review", metadata: { voiceTranscript: "به ایشان بگو unsubscribe را انجام می‌دهم" } });
    expect(s.telegram.editMessage).toHaveBeenLastCalledWith(100, expect.stringContaining("بازبینی متن Voice"), expect.any(Array));

    await (s.app as any).handleCallback("cb-confirm", `m:${s.id}:voiceconfirm`);
    expect(s.ai.draftReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: s.id }), "به ایشان بگو unsubscribe را انجام می‌دهم", "formal", false, [incoming]
    );
    expect(s.store.getConversation(42, s.id)).toMatchObject({ mode: "review", draft: "پیش‌نویس صوتی" });
    s.store.close();
  });

  it("shows both raw ASR outputs and accepts a manual transcript correction", async () => {
    const s = setup();
    s.store.setConversation(42, s.id, "voice_review", false, "formal", undefined, {
      voiceTranscript: "unsubscribe را انجام بده", voiceCandidates: [{ model: "qwen", text: "آن سابسکرایب" }, { model: "whisper", text: "unsubscribe" }],
      voiceConsensus: { finalTranscript: "unsubscribe را انجام بده", confidence: 0.7, uncertainTerms: ["unsubscribe"], rationale: "اختلاف" }
    });
    await (s.app as any).handleCallback("cb-raw", `m:${s.id}:voiceraw`);
    expect(s.telegram.editMessage).toHaveBeenLastCalledWith(100, expect.stringContaining("<b>whisper:</b>"), expect.any(Array));
    await (s.app as any).handleCallback("cb-edit", `m:${s.id}:voiceedit`);
    await (s.app as any).handleText({ message_id: 610, chat: { id: 42 }, reply_to_message: { message_id: 200 }, text: "به ایشان بگو Unsubscribe را انجام دهد", from: { id: 42 } });
    expect(s.store.getConversation(42, s.id)).toMatchObject({ mode: "voice_review", metadata: { voiceTranscript: "به ایشان بگو Unsubscribe را انجام دهد" } });
    s.store.close();
  });

  it("opens a voice prompt after removing stale auxiliary messages", async () => {
    const s = setup();
    (s.app as any).config.VOICE_REPLY_ENABLED = true;
    s.store.setConversation(42, s.id, "review", false, "formal", "draft");
    await (s.app as any).handleCallback("cb-voice", `m:${s.id}:voice`);
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([101]);
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([100, 200]);
    expect(s.store.getConversation(42, s.id)).toMatchObject({ mode: "voice_instruction", promptMessageId: 200 });
    s.store.close();
  });

  it("rejects an oversized voice before downloading it", async () => {
    const s = setup();
    (s.app as any).config.VOICE_REPLY_ENABLED = true;
    s.store.setConversation(42, s.id, "voice_instruction", false, "formal", undefined, undefined, 501);
    await (s.app as any).handleText({
      message_id: 602, chat: { id: 42 }, reply_to_message: { message_id: 501 }, from: { id: 42 },
      voice: { file_id: "too-large", file_unique_id: "large", duration: 12, file_size: 10_000_001 }
    });
    expect(s.telegram.downloadFile).not.toHaveBeenCalled();
    expect(s.stt.transcribe).not.toHaveBeenCalled();
    s.store.close();
  });
});
