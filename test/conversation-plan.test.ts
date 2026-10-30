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
});
