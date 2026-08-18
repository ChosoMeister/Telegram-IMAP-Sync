import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";

export async function extractAttachmentText(filename: string, contentType: string, content: Buffer): Promise<string | undefined> {
  const type = contentType.toLowerCase();
  const name = filename.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    const parser = new PDFParse({ data: new Uint8Array(content) });
    try { return (await parser.getText()).text.trim(); }
    finally { await parser.destroy(); }
  }
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || name.endsWith(".docx")) {
    return (await mammoth.extractRawText({ buffer: content })).value.trim();
  }
  if (type === "text/html" || name.endsWith(".html") || name.endsWith(".htm")) {
    return sanitizeHtml(content.toString("utf8"), { allowedTags: [], allowedAttributes: {} }).trim();
  }
  if (type.startsWith("text/") || /\.(?:txt|csv|tsv|json|xml|log)$/i.test(name)) return content.toString("utf8").trim();
  return undefined;
}

export function canExtractAttachment(filename: string, contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type === "application/pdf"
    || type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || type === "text/html" || type.startsWith("text/")
    || /\.(?:pdf|docx|html?|txt|csv|tsv|json|xml|log)$/i.test(filename);
}
