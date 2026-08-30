import { describe, expect, it } from "vitest";
import { LearnedRuleService } from "../src/learned-rules.js";
import { Store } from "../src/store.js";
import { incoming } from "./helpers.js";

const baseAnalysis = {
  importance: "high" as const, score: 82, summaryFa: "خلاصه", suggestedAction: "بررسی کنید",
  reason: "درخواست", provider: "test", actionOwner: "self" as const, riskFa: "تأخیر"
};

describe("learned analysis rules", () => {
  it("persists, reconfirms, disables, and restores rules in SQLite", () => {
    const store = new Store(":memory:");
    const first = store.saveLearnedRule({ accountId: "orchid", scope: "sender", senderEmail: "sender@example.com", effect: "not_mine", sourceMailId: 1 });
    const second = store.saveLearnedRule({ accountId: "orchid", scope: "sender", senderEmail: "sender@example.com", effect: "not_mine", sourceMailId: 2 });
    expect(second.id).toBe(first.id);
    expect(second.confirmationCount).toBe(2);
    expect(store.setLearnedRuleEnabled(first.id, false)?.enabled).toBe(false);
    expect(store.listLearnedRules(false)).toHaveLength(0);
    expect(store.setLearnedRuleEnabled(first.id, true)?.enabled).toBe(true);
    store.close();
  });

  it("uses the most specific account-scoped rule and keeps informational mail low", () => {
    const store = new Store(":memory:");
    const service = new LearnedRuleService(store);
    const { id } = store.upsertMail({ ...incoming, accountId: "orchid", accountLabel: "Orchid", subject: "FW: Daily Report" });
    const mail = store.getMail(id)!;
    store.saveLearnedRule({ accountId: "orchid", scope: "domain", senderDomain: "example.com", effect: "importance", effectValue: "high" });
    const specific = store.saveLearnedRule({ accountId: "orchid", scope: "sender_subject", senderEmail: "sender@example.com", subjectPattern: "daily report", effect: "importance", effectValue: "low" });
    const informational = store.saveLearnedRule({ accountId: "orchid", scope: "sender", senderEmail: "sender@example.com", effect: "informational" });
    store.saveLearnedRule({ accountId: "axon", scope: "sender", senderEmail: "sender@example.com", effect: "importance", effectValue: "critical" });

    const result = service.applyMatching(mail, baseAnalysis);
    expect(result).toMatchObject({ importance: "low", score: 25, category: "informational", actionOwner: "other" });
    expect(result.riskFa).toBeUndefined();
    expect(result.appliedRuleIds).toEqual(expect.arrayContaining([specific.id, informational.id]));
    expect(service.trustedGuidance(mail)).toContain("Verified user rule");
    store.close();
  });

  it("never applies a rule from another IMAP account", () => {
    const store = new Store(":memory:");
    const service = new LearnedRuleService(store);
    const { id } = store.upsertMail({ ...incoming, accountId: "orchid", accountLabel: "Orchid" });
    store.saveLearnedRule({ accountId: "axon", scope: "sender", senderEmail: "sender@example.com", effect: "informational" });
    expect(service.applyMatching(store.getMail(id)!, baseAnalysis)).toEqual(baseAnalysis);
    expect(service.trustedGuidance(store.getMail(id)!)).toBeUndefined();
    store.close();
  });
});
