import { describe, expect, it, vi } from "vitest";
import { Store } from "../src/store.js";
import { AutomationService } from "../src/automation.js";
import { incoming } from "./helpers.js";

const analysis = { importance: "low" as const, score: 20, summaryFa: "خبرنامه", suggestedAction: "اقدامی لازم نیست",
  reason: "اطلاع‌رسانی", provider: "test", actionOwner: "other" as const, category: "informational" as const };

describe("automation observation and execution gates", () => {
  it("records a matching observation without changing mail", async () => {
    const store = new Store(":memory:");
    const { id } = store.upsertMail({ ...incoming, subject: "خبرنامه هفتگی" });
    store.setAnalysis(id, analysis);
    const policy = store.saveAutomationPolicy({ name: "خبرنامه‌های بدون اقدام", category: "newsletter", action: "archive", scope: "global",
      exceptions: ["انقضا"], source: "user" });
    const execute = vi.fn();
    const service = new AutomationService(store, "observe", execute);
    const decision = await service.evaluate(store.getMail(id)!, true);
    expect(decision).toMatchObject({ policyId: policy.id, outcome: "would_archive" });
    expect(execute).not.toHaveBeenCalled();
    expect(store.getMail(id)?.state).toBe("pending");
    store.close();
  });

  it("preserves exceptions and important FYI alerts", async () => {
    const store = new Store(":memory:");
    const { id } = store.upsertMail({ ...incoming, subject: "خبرنامه: هشدار انقضا SSL" });
    store.setAnalysis(id, { ...analysis, importance: "critical", score: 98, riskFa: "قطع سرویس" });
    store.saveAutomationPolicy({ name: "خبرنامه‌ها", category: "newsletter", action: "archive", scope: "global", exceptions: ["انقضا"], source: "user" });
    const decision = await new AutomationService(store, "execute", vi.fn()).evaluate(store.getMail(id)!, true);
    expect(decision).toMatchObject({ outcome: "skipped" });
    expect(decision?.reason).toContain("استثنا");
    store.close();
  });

  it("executes only for eligible new mail when mode is execute", async () => {
    const store = new Store(":memory:");
    const { id } = store.upsertMail({ ...incoming, subject: "Newsletter weekly" });
    store.setAnalysis(id, analysis);
    store.saveAutomationPolicy({ name: "خبرنامه‌ها", category: "newsletter", action: "archive", scope: "global", exceptions: [], source: "user" });
    const execute = vi.fn().mockResolvedValue(undefined);
    const service = new AutomationService(store, "execute", execute);
    expect((await service.evaluate(store.getMail(id)!, false))?.outcome).toBe("skipped");
    expect((await service.evaluate(store.getMail(id)!, true))?.outcome).toBe("executed");
    expect(execute).toHaveBeenCalledOnce();
    store.close();
  });

  it("rejects an account-scoped policy without an account identity", () => {
    const store = new Store(":memory:");
    expect(() => store.saveAutomationPolicy({ name: "خبرنامه‌ها", category: "newsletter", action: "archive", scope: "account",
      exceptions: [], source: "user" })).toThrow("accountId");
    store.close();
  });
});
