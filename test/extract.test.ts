import { describe, expect, it } from "vitest";
import { canExtractAttachment, extractAttachmentText } from "../src/mail/extract.js";

describe("attachment text extraction", () => {
  it("extracts UTF-8 text and CSV without persisting files", async () => {
    await expect(extractAttachmentText("notes.txt", "text/plain", Buffer.from("سلام دنیا"))).resolves.toBe("سلام دنیا");
    await expect(extractAttachmentText("invoice.csv", "text/csv", Buffer.from("item,amount\nA,100"))).resolves.toContain("A,100");
  });
  it("removes HTML markup before AI context", async () => {
    await expect(extractAttachmentText("page.html", "text/html", Buffer.from("<p>مبلغ <b>100</b></p>"))).resolves.toContain("مبلغ 100");
  });
  it("returns undefined for unsupported binary types", async () => {
    expect(canExtractAttachment("archive.zip", "application/zip")).toBe(false);
    expect(canExtractAttachment("contract.pdf", "application/pdf")).toBe(true);
    await expect(extractAttachmentText("archive.zip", "application/zip", Buffer.from("zip"))).resolves.toBeUndefined();
  });
});
