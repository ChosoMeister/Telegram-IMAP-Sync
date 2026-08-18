import { describe, expect, it } from "vitest";
import { buildReply } from "../src/ai.js";
import { SmtpService } from "../src/mail/smtp.js";
import { config } from "./helpers.js";
import { incoming } from "./helpers.js";

describe("reply builder", () => {
  const mail = { ...incoming, id: 1, state: "pending" as const, telegramMessageIds: [] };
  it("builds Reply All without sending to self or duplicating sender", () => {
    const draft = buildReply(mail, "تأیید است", true, "me@example.com");
    expect(draft.to.map((x) => x.address)).toEqual(["sender@example.com"]);
    expect(draft.cc.map((x) => x.address)).toEqual(["team@example.com"]);
    expect(draft.subject).toBe("Re: Test");
    expect(draft.html).toContain("تأیید است");
  });
  it("adds no signature markup or trailing whitespace", () => {
    const draft = buildReply(mail, "پاسخ نهایی", false, "me@example.com");
    expect(draft.text).toBe("پاسخ نهایی");
    expect(draft.html).toBe('<div dir="auto">پاسخ نهایی</div>');
  });
  it("builds one RFC822 message that can be sent and appended to Sent", async () => {
    const draft = buildReply(mail, "پاسخ نهایی", true, "me@example.com");
    const raw = (await new SmtpService(config).buildReply(mail, draft)).toString("utf8");
    expect(raw).toContain("From: me@example.com");
    expect(raw).toContain("To: Sender <sender@example.com>");
    expect(raw).toContain("Cc: team@example.com");
    expect(raw).toContain("In-Reply-To: <mail@example.com>");
  });
});
