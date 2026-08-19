import { describe, expect, it } from "vitest";
import { mailButtons } from "../src/telegram/render.js";
import type { StoredMail } from "../src/domain/types.js";
import { incoming } from "./helpers.js";

const stored = (id: number): StoredMail => ({ ...incoming, id, state: "pending", telegramMessageIds: [] });

describe("mail card buttons", () => {
  it("does not show the redundant all-messages action for a single message", () => {
    const mail = stored(1);
    const rows = mailButtons(mail, [mail]);
    expect(rows.flat().map((button) => button.text)).not.toContain("📚 همه پیام‌ها");
    expect(rows[0]?.map((button) => button.text)).toEqual(["↩️ پاسخ", "✅ انجام شد"]);
    expect(rows[2]?.map((button) => button.text)).toEqual(["📄 متن پیام", "✨ پرسش از AI"]);
  });

  it("shows latest and all-message actions for a merged thread", () => {
    const mail = stored(2);
    const rows = mailButtons(mail, [stored(1), mail]);
    expect(rows[2]?.map((button) => button.text)).toEqual(["📄 آخرین پیام", "📚 همه پیام‌ها"]);
    expect(rows[3]?.map((button) => button.text)).toEqual(["✨ پرسش از AI"]);
  });

  it("uses Persian conditional Reply All and counts secondary content", () => {
    const mail = { ...stored(1), attachments: [
      { id: "a", filename: "file.pdf", contentType: "application/pdf", size: 1, disposition: "attachment", isRealAttachment: true },
      { id: "b", filename: "logo.png", contentType: "image/png", size: 1, disposition: "inline", isRealAttachment: false }
    ] };
    const labels = mailButtons(mail, [mail]).flat().map((button) => button.text);
    expect(labels).toContain("👥 پاسخ به همه");
    expect(labels).toContain("📎 پیوست‌ها (1)");
    expect(labels).toContain("🖼 موارد مخفی (1)");
  });
});
