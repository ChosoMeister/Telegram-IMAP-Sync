import { describe, expect, it } from "vitest";
import { htmlToReadableText, parsedMailToIncoming, splitTelegramText, stripQuotedHistory } from "../src/mail/content.js";

describe("mail content", () => {
  it("extracts readable text from Outlook-like HTML", () => {
    expect(htmlToReadableText("<style>.x{}</style><p dir='rtl'>سلام&nbsp;دنیا</p><p>خط دوم</p>")).toContain("سلام دنیا");
  });
  it("removes quoted reply history", () => {
    expect(stripQuotedHistory("پاسخ من\n\nOn Tue, Person wrote:\n> old")).toBe("پاسخ من");
  });
  it("splits long Telegram content without loss", () => {
    const source = Array.from({ length: 1000 }, (_, i) => `خط ${i}`).join("\n");
    const chunks = splitTelegramText(source, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join("\n").replace(/\s/g, "")).toBe(source.replace(/\s/g, ""));
  });
  it("separates Outlook signature assets from real image and document attachments", () => {
    const png = (width: number, height: number) => {
      const value = Buffer.alloc(32); value.write("\x89PNG", 0, "binary"); value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20); return value;
    };
    const mail = parsedMailToIncoming({
      subject: "Attachments", text: "See files", html: "<img src=\"cid:logo-id\">",
      attachments: [
        { filename: "invoice.pdf", contentType: "application/pdf", contentDisposition: "attachment", size: 1000, content: Buffer.from("pdf") },
        { filename: "image001.png", contentType: "image/png", contentDisposition: "attachment", size: 32, content: png(600, 120) },
        { filename: "screenshot.png", contentType: "image/png", contentDisposition: "attachment", size: 700_000, content: png(1600, 900) },
        { filename: "random-name.png", contentType: "image/png", contentDisposition: "attachment", cid: "logo-id", size: 32, content: png(100, 40) }
      ]
    } as any, { uid: 1, uidValidity: "1", mailbox: "INBOX" });
    expect(mail.attachments.map((item) => [item.filename, item.classification, item.isRealAttachment])).toEqual([
      ["invoice.pdf", "real", true], ["image001.png", "signature", false],
      ["screenshot.png", "real", true], ["random-name.png", "inline", false]
    ]);
    expect(mail.attachments.every((item) => item.sha256?.length === 64)).toBe(true);
  });
  it("detects and structures a calendar payload independently of its filename", () => {
    const ics = [
      "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:event-1@example.com",
      "SUMMARY:ذخیره سازی مدارک ویدیویی بیمار", "DTSTART;TZID=\"(UTC+03:30) Tehran\":20260820T103000",
      "DTEND;TZID=\"(UTC+03:30) Tehran\":20260820T110000", "LOCATION:جلسه آنلاین",
      "ORGANIZER;CN=Marjan Hosseini:mailto:marjan@example.com", "ATTENDEE;CN=Mustafa:mailto:mustafa@example.com",
      "DESCRIPTION:درخواست کننده\\: فاطمه", "END:VEVENT", "END:VCALENDAR"
    ].join("\r\n");
    const mail = parsedMailToIncoming({
      subject: "Calendar", text: "درخواست کننده: فاطمه", attachments: [
        { filename: undefined, contentType: "text/calendar", contentDisposition: "attachment", size: ics.length, content: Buffer.from(ics) }
      ]
    } as any, { uid: 1, uidValidity: "1", mailbox: "INBOX" });
    expect(mail.calendar).toMatchObject({ method: "REQUEST", summary: "ذخیره سازی مدارک ویدیویی بیمار", location: "جلسه آنلاین", organizer: { address: "marjan@example.com" } });
    expect(mail.calendar?.attendees).toHaveLength(1);
    expect(mail.calendar?.start).toMatchObject({ raw: "20260820T103000", timeZone: "Asia/Tehran", iso: "2026-08-20T07:00:00.000Z" });
    expect(mail.attachments[0]).toMatchObject({ filename: "attachment-1", classification: "calendar", isRealAttachment: false });
  });
});
