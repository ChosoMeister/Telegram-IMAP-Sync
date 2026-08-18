import { describe, expect, it } from "vitest";
import { htmlToReadableText, splitTelegramText, stripQuotedHistory } from "../src/mail/content.js";

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
});
