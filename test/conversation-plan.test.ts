import { describe, expect, it } from "vitest";
import { parseConversationPlan } from "../src/conversation/plan.js";

describe("validated conversation plans", () => {
  it("accepts a bounded multi-step plan without internal mail identifiers", () => {
    expect(parseConversationPlan({ summaryFa: "پاسخ و سپس پیگیری", needsClarification: false, actions: [
      { kind: "draft_reply", target: "this_mail", instruction: "نسخه اصلاح‌شده را درخواست کن", tone: "formal", replyAll: false },
      { kind: "ask", target: "this_mail", question: "مهلت پاسخ چیست؟" }
    ] }).actions).toHaveLength(2);
  });

  it("rejects arbitrary targets and unvalidated tool names", () => {
    expect(() => parseConversationPlan({ summaryFa: "خطرناک", needsClarification: false,
      actions: [{ kind: "sql", target: "mail:999", query: "DELETE FROM mails" }] })).toThrow();
  });

  it("requires a short clarification question when the target is ambiguous", () => {
    expect(() => parseConversationPlan({ summaryFa: "مبهم", needsClarification: true, actions: [] })).toThrow();
  });
  it("accepts only structured memory fields for an explicit user correction", () => {
    const plan = parseConversationPlan({ summaryFa: "ثبت اصلاح", needsClarification: false, actions: [{
      kind: "remember", target: "this_mail", memoryKind: "correction", key: "finance_cc_role",
      statement: "در مکاتبات مالی این حساب فقط ناظر هستم", scope: "account"
    }] });
    expect(plan.actions[0]).toMatchObject({ kind: "remember", memoryKind: "correction", scope: "account" });
  });
  it("validates a durable task with an explicit ISO reminder time", () => {
    const plan = parseConversationPlan({ summaryFa: "ثبت پیگیری", needsClarification: false, actions: [{
      kind: "create_task", target: "this_mail", title: "پاسخ به درخواست", taskState: "open",
      dueAt: "2026-11-01T10:00:00+03:30", needsReminder: true
    }] });
    expect(plan.actions[0]).toMatchObject({ kind: "create_task", needsReminder: true });
  });
});
