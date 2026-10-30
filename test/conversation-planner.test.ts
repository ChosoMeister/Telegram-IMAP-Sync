import { describe, expect, it } from "vitest";
import { planConversation } from "../src/conversation/planner.js";

describe("conversation planner", () => {
  it.each([
    ["این رو آرشیو کن", { kind: "archive" }],
    ["پاسخ به همه بده", { kind: "reply", replyAll: true }],
    ["لطفاً جواب بده", { kind: "reply", replyAll: false }],
    ["برای همکارم فوروارد کن", { kind: "forward" }],
    ["کنسل", { kind: "cancel" }]
  ])("maps %s to a bounded intent", (text, expected) => expect(planConversation(text)).toEqual(expected));

  it("treats unrecognized text as a question, never as an arbitrary tool call", () => {
    expect(planConversation("مهلت این ایمیل چه زمانی است؟")).toEqual({ kind: "ask", question: "مهلت این ایمیل چه زمانی است؟" });
  });
});
