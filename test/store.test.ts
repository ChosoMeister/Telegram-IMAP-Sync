import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { incoming } from "./helpers.js";

describe("Store", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });
  afterEach(() => store.close());

  it("deduplicates by mailbox, UIDVALIDITY and UID", () => {
    const first = store.upsertMail(incoming);
    const second = store.upsertMail(incoming);
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
  });
  it("returns known UIDs only for the current mailbox identity", () => {
    store.upsertMail(incoming);
    store.upsertMail({ ...incoming, uid: 8 });
    store.upsertMail({ ...incoming, uid: 9, uidValidity: "different" });
    expect([...store.listKnownUids(incoming.mailbox, incoming.uidValidity)].sort()).toEqual([7, 8]);
  });
  it("persists analysis, Telegram IDs and conversation state", () => {
    const { id } = store.upsertMail(incoming);
    store.setAnalysis(id, { importance: "high", score: 80, summaryFa: "خلاصه", suggestedAction: "اقدام", reason: "مهلت", provider: "test" });
    store.setTelegramMessages(id, [10, 11]);
    store.setConversation(42, id, "review", true, "formal", "draft", { kind: "forward", recipients: ["colleague@example.com"] });
    expect(store.getMail(id)?.analysis?.score).toBe(80);
    expect(store.getMail(id)?.telegramMessageIds).toEqual([10, 11]);
    expect(store.getConversation(42)).toMatchObject({ mailId: id, replyAll: true, draft: "draft", metadata: { kind: "forward", recipients: ["colleague@example.com"] } });
  });
  it("keeps independent drafts for multiple mails", () => {
    const first = store.upsertMail(incoming);
    const second = store.upsertMail({ ...incoming, uid: 8 });
    store.setConversation(42, first.id, "review", false, "formal", "first draft");
    store.setConversation(42, second.id, "review", true, "friendly", "second draft");
    expect(store.getConversation(42, first.id)?.draft).toBe("first draft");
    expect(store.getConversation(42, second.id)?.draft).toBe("second draft");
    store.clearConversation(42, second.id);
    expect(store.getConversation(42, first.id)?.draft).toBe("first draft");
    expect(store.getConversation(42, second.id)).toBeUndefined();
  });
  it("durably tracks one outbound RFC822 payload through all stages", () => {
    const { id } = store.upsertMail(incoming);
    const created = store.createOutbound(id, "reply", "<stable@example.com>", Buffer.from("raw-message"));
    expect(created).toMatchObject({ messageId: "<stable@example.com>", smtpAttempted: false, smtpAccepted: false, sentSaved: false });
    store.markOutbound(id, "attempt");
    expect(store.getOutbound(id)).toMatchObject({ smtpAttempted: true, smtpAccepted: false });
    store.markOutbound(id, "smtp");
    expect(store.getOutbound(id)).toMatchObject({ smtpAccepted: true, sentSaved: false });
    store.markOutbound(id, "sent");
    expect(store.getOutbound(id)).toMatchObject({ smtpAccepted: true, sentSaved: true, completed: false });
    store.markOutbound(id, "complete");
    expect(store.getOutbound(id)).toMatchObject({ completed: true });
    expect(store.getOutbound(id)?.raw.toString()).toBe("raw-message");
  });
  it("uses expiring atomic locks for mail actions", () => {
    const { id } = store.upsertMail(incoming);
    expect(store.acquireActionLock(id, "reply", "first", 60_000)).toBe(true);
    expect(store.acquireActionLock(id, "reply", "second", 60_000)).toBe(false);
    store.releaseActionLock(id, "second");
    expect(store.acquireActionLock(id, "reply", "third", 60_000)).toBe(false);
    store.releaseActionLock(id, "first");
    expect(store.acquireActionLock(id, "reply", "third", 60_000)).toBe(true);
  });
  it("leases and recovers durable jobs", () => {
    const { id } = store.upsertMail(incoming);
    store.enqueueJob("analyze", id, { source: "sync" });
    const job = store.leaseJob(60_000);
    expect(job).toMatchObject({ kind: "analyze", mailId: id, attempts: 1, payload: { source: "sync" } });
    expect(store.leaseJob()).toBeUndefined();
    store.failJob(job!.id, "temporary", 0);
    expect(store.leaseJob()).toMatchObject({ id: job!.id, attempts: 2 });
    store.completeJob(job!.id);
    expect(store.jobCounts()).toMatchObject({ complete: 1 });
  });
});
