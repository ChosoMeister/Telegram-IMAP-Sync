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
  it("persists analysis, Telegram IDs and conversation state", () => {
    const { id } = store.upsertMail(incoming);
    store.setAnalysis(id, { importance: "high", score: 80, summaryFa: "خلاصه", suggestedAction: "اقدام", reason: "مهلت", provider: "test" });
    store.setTelegramMessages(id, [10, 11]);
    store.setConversation(42, id, "review", true, "formal", "draft");
    expect(store.getMail(id)?.analysis?.score).toBe(80);
    expect(store.getMail(id)?.telegramMessageIds).toEqual([10, 11]);
    expect(store.getConversation(42)).toMatchObject({ mailId: id, replyAll: true, draft: "draft" });
  });
});
