import { describe, expect, it, vi } from "vitest";
import { MailBotApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { Logger } from "../src/logger.js";
import { config, incoming } from "./helpers.js";

function setup(archive = vi.fn().mockResolvedValue(undefined)) {
  const isolatedConfig = { ...config, aiProviderOrder: [...config.aiProviderOrder] };
  const store = new Store(":memory:");
  const { id } = store.upsertMail(incoming);
  store.setTelegramMessages(id, [100, 101]);
  const telegram = {
    answerCallbackQuery: vi.fn().mockResolvedValue(true), deleteMessages: vi.fn().mockResolvedValue(true),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 200, chat: { id: 42 } }), editMessage: vi.fn().mockResolvedValue(true),
    sendDocument: vi.fn(), getUpdates: vi.fn()
  };
  const imap = {
    archive, fetchAttachment: vi.fn(), scanInbox: vi.fn().mockResolvedValue([]), connect: vi.fn(), waitForChanges: vi.fn(), stop: vi.fn(),
    mailboxIdentity: vi.fn().mockReturnValue({ path: incoming.mailbox, uidValidity: incoming.uidValidity }), isConnected: vi.fn().mockReturnValue(true),
    listInboxUids: vi.fn().mockResolvedValue(new Set([incoming.uid]))
  };
  const ai = { analyze: vi.fn().mockResolvedValue(undefined) };
  const app = new MailBotApp(isolatedConfig, store, imap as any, {} as any, telegram as any, ai as any, new Logger("error"));
  return { app, store, telegram, imap, archive, id };
}

describe("Done transaction", () => {
  it("archives before deleting Telegram messages", async () => {
    const s = setup();
    (s.app as any).config.APP_MODE = "live";
    await (s.app as any).handleCallback("cb", `m:${s.id}:done`);
    expect(s.archive).toHaveBeenCalledOnce();
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([100, 101]);
    expect(s.store.getMail(s.id)?.state).toBe("done");
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
});

describe("pending queue rotation", () => {
  it("republishes the complete queue oldest first when any item expires", async () => {
    const s = setup();
    s.store.setTelegramMessages(s.id, [100], new Date("2026-08-16T00:00:00Z"));
    const newer = s.store.upsertMail({ ...incoming, uid: 8, subject: "Newer", receivedAt: new Date("2026-08-18T11:00:00Z") });
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
    expect(s.telegram.deleteMessages).toHaveBeenCalledWith([100, 101]);
    expect(s.store.getMail(s.id)?.telegramMessageIds).toEqual([]);
    s.store.close();
  });
});

describe("single-card navigation", () => {
  it("renders full body by editing the primary message instead of sending a new one", async () => {
    const s = setup();
    await (s.app as any).showBody(s.store.getMail(s.id), 0);
    expect(s.telegram.editMessage).toHaveBeenCalledWith(100, expect.stringContaining("متن ایمیل"), expect.any(Array));
    expect(s.telegram.sendMessage).not.toHaveBeenCalled();
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
});
