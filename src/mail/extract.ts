import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import sanitizeHtml from "sanitize-html";
import ExcelJS from "exceljs";

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
  if (type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || name.endsWith(".xlsx")) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(content as unknown as ExcelJS.Buffer);
    const sheets: string[] = [];
    for (const worksheet of workbook.worksheets.slice(0, 20)) {
      const rows: string[] = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > 500) return;
        rows.push((row.values as unknown[]).slice(1, 101).map(cellText).join("\t"));
      });
      sheets.push(`SHEET: ${worksheet.name}\n${rows.join("\n")}`);
    }
    return sheets.join("\n\n").trim();
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
    || type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || type === "text/html" || type.startsWith("text/")
    || /\.(?:pdf|docx|xlsx|html?|txt|csv|tsv|json|xml|log)$/i.test(filename);
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const cell = value as { text?: string; result?: unknown; richText?: Array<{ text?: string }> };
    if (typeof cell.text === "string") return cell.text;
    if (cell.result !== undefined) return String(cell.result);
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text ?? "").join("");
  }
  return String(value);
}
