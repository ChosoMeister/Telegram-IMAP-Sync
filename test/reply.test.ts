import { describe, expect, it } from "vitest";
import { buildReply } from "../src/ai.js";
import { SmtpService } from "../src/mail/smtp.js";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
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
  it("keeps an explicitly assigned Message-ID in the durable RFC822 payload", async () => {
    const draft = buildReply(mail, "پاسخ نهایی", false, "me@example.com");
    const raw = await new SmtpService(config).buildReply(mail, draft, "<mailbot-stable@example.com>");
    const parsed = await simpleParser(raw);
    expect(parsed.messageId).toBe("<mailbot-stable@example.com>");
  });
  it("builds a forward with the user note, original body and real attachments", async () => {
    const source = await new MailComposer({
      from: "sender@example.com", to: "me@example.com", subject: "Invoice", text: "Original body",
      attachments: [{ filename: "invoice.pdf", content: Buffer.from("PDF") }]
    }).compile().build();
    const forwardedMail = { ...mail, text: "Original body", attachments: [{
      partId: "0", filename: "invoice.pdf", contentType: "application/pdf", size: 3,
      contentDisposition: "attachment" as const, isRealAttachment: true
    }] };
    const raw = await new SmtpService(config).buildForward(forwardedMail, ["colleague@example.com"], "لطفاً بررسی کنید.", source);
    const parsed = await simpleParser(raw);
    expect(parsed.to?.text).toContain("colleague@example.com");
    expect(parsed.text).toContain("لطفاً بررسی کنید.");
    expect(parsed.text).toContain("Original body");
    expect(parsed.attachments.map((item) => item.filename)).toEqual(["invoice.pdf"]);
  });
});
