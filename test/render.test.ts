import { describe, expect, it } from "vitest";
import { mailButtons } from "../src/telegram/render.js";
import type { StoredMail } from "../src/domain/types.js";
import { incoming } from "./helpers.js";

const stored = (id: number): StoredMail => ({ ...incoming, id, state: "pending", telegramMessageIds: [] });

describe("mail card buttons", () => {
  it("does not show the redundant all-messages action for a single message", () => {
    const mail = stored(1);
    expect(mailButtons(mail, [mail])[0]).toEqual([
      expect.objectContaining({ text: "📄 متن پیام", callback_data: "m:1:body" })
    ]);
  });

  it("shows latest and all-message actions for a merged thread", () => {
    const mail = stored(2);
    const row = mailButtons(mail, [stored(1), mail])[0]!;
    expect(row.map((button) => button.text)).toEqual(["📄 آخرین پیام", "📚 متن همه پیام‌ها"]);
  });
});
