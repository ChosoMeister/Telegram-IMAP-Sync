import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { MemoryService } from "../src/memory.js";
import { incoming } from "./helpers.js";

describe("structured memory", () => {
  it("supersedes an older confirmed fact with an explicit correction", () => {
    const store = new Store(":memory:");
    const service = new MemoryService(store);
    const first = service.remember({ kind: "preference", key: "reply_style", statement: "پاسخ‌ها کوتاه باشند", scope: "global", confidence: "confirmed", source: "user" });
    const second = service.remember({ kind: "preference", key: "reply_style", statement: "پاسخ‌ها رسمی و با جزئیات کافی باشند", scope: "global", confidence: "confirmed", source: "user" });
    expect(store.getMemory(first.id)?.status).toBe("superseded");
    expect(second.supersedesId).toBe(first.id);
    expect(service.trustedGuidance({ ...incoming, id: 1, state: "pending", telegramMessageIds: [], accountId: "orchid" })).toContain("با جزئیات کافی");
    expect(service.trustedGuidance({ ...incoming, id: 1, state: "pending", telegramMessageIds: [], accountId: "orchid" })).not.toContain("کوتاه باشند");
    store.close();
  });

  it("isolates account memory and excludes inferred facts from trusted guidance", () => {
    const store = new Store(":memory:");
    const service = new MemoryService(store);
    service.remember({ kind: "role", key: "finance_cc", statement: "در این حساب فقط ناظر مالی هستم", scope: "account", accountId: "axon", confidence: "confirmed", source: "user" });
    service.remember({ kind: "pattern", key: "possible_newsletter", statement: "شاید خبرنامه‌ها اقدامی نخواهند", scope: "global", confidence: "inferred", source: "model" });
    const axon = service.trustedGuidance({ ...incoming, id: 1, state: "pending", telegramMessageIds: [], accountId: "axon" });
    const orchid = service.trustedGuidance({ ...incoming, id: 2, state: "pending", telegramMessageIds: [], accountId: "orchid" });
    expect(axon).toContain("ناظر مالی");
    expect(axon).not.toContain("شاید خبرنامه‌ها");
    expect(orchid).toBeUndefined();
    store.close();
  });

  it("can explicitly revert to a disabled memory without two active conflicting values", () => {
    const store = new Store(":memory:");
    const service = new MemoryService(store);
    const old = service.remember({ kind: "preference", key: "tone", statement: "کوتاه", scope: "global", confidence: "confirmed", source: "user" });
    store.setMemoryEnabled(old.id, false);
    const current = service.remember({ kind: "preference", key: "tone", statement: "رسمی", scope: "global", confidence: "confirmed", source: "user" });
    store.setMemoryEnabled(old.id, true);
    expect(store.getMemory(old.id)?.status).toBe("active");
    expect(store.getMemory(current.id)?.status).toBe("superseded");
    expect(store.listMemories()).toHaveLength(1);
    store.close();
  });

  it("keeps a confirmed working preference after restart and a new conversation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbot-memory-restart-"));
    const path = join(directory, "mailbot.sqlite");
    const before = new Store(path);
    new MemoryService(before).remember({ kind: "preference", key: "working_morning", statement: "اول صبح کاری ساعت ۱۰ است",
      scope: "global", confidence: "confirmed", source: "user" });
    before.close();
    const after = new Store(path);
    expect(new MemoryService(after).trustedGuidance({ ...incoming, id: 1, state: "pending", telegramMessageIds: [] }))
      .toContain("اول صبح کاری ساعت ۱۰ است");
    after.close();
    await rm(directory, { recursive: true, force: true });
  });
});
