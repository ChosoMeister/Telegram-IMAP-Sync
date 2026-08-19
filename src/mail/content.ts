import sanitizeHtml from "sanitize-html";
import { createHash } from "node:crypto";
import type { Attachment, ParsedMail } from "mailparser";
import type { Address, IncomingMail, MailAttachment } from "../domain/types.js";
import { parseCalendar } from "./calendar.js";

const quoteMarkers = [/^On .+wrote:$/im, /^From:\s.+$/im, /^-{2,}\s*Original Message\s*-{2,}$/im];

export function htmlToReadableText(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text
  })
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripQuotedHistory(text: string): string {
  let end = text.length;
  for (const marker of quoteMarkers) {
    const match = marker.exec(text);
    if (match?.index !== undefined) end = Math.min(end, match.index);
  }
  return text.slice(0, end).replace(/^>.*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function splitTelegramText(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const candidate = remaining.slice(0, limit);
    const boundary = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"), candidate.lastIndexOf(" "));
    const cut = boundary > limit * 0.6 ? boundary : limit;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function addresses(value: ParsedMail["from"] | ParsedMail["to"]): Address[] {
  const values = Array.isArray(value) ? value.flatMap((item) => item.value) : value?.value ?? [];
  return values.map((item) => ({
    ...(item.name ? { name: item.name } : {}),
    address: item.address ?? ""
  })).filter((item) => item.address);
}

function attachmentMeta(attachment: Attachment, index: number, html?: string): MailAttachment {
  const disposition = attachment.contentDisposition === "inline" ? "inline" : "attachment";
  const referenced = Boolean(attachment.cid && html && new RegExp(`cid:${escapeRegex(attachment.cid)}`, "i").test(html));
  const filename = attachment.filename || `attachment-${index + 1}`;
  if (attachment.contentType.toLowerCase() === "text/calendar") return {
    partId: String(index), filename, contentType: attachment.contentType, size: attachment.size,
    contentDisposition: disposition, classification: "calendar", classificationReason: "structured calendar payload",
    sha256: createHash("sha256").update(attachment.content).digest("hex"), isRealAttachment: false
  };
  const image = attachment.contentType.toLowerCase().startsWith("image/");
  const dimensions = imageDimensions(attachment.content, attachment.contentType);
  const classification = classifyAttachment({ filename, image, disposition, referenced, size: attachment.size, ...dimensions });
  return {
    partId: String(index),
    filename,
    contentType: attachment.contentType,
    size: attachment.size,
    contentDisposition: disposition,
    ...(attachment.cid ? { contentId: attachment.cid } : {}),
    classification: classification.kind,
    classificationReason: classification.reason,
    sha256: createHash("sha256").update(attachment.content).digest("hex"),
    ...dimensions,
    isRealAttachment: classification.kind === "real"
  };
}

function classifyAttachment(input: {
  filename: string; image: boolean; disposition: "inline" | "attachment"; referenced: boolean;
  size: number; width?: number; height?: number;
}): { kind: NonNullable<MailAttachment["classification"]>; reason: string } {
  if (!input.image) return { kind: "real", reason: "non-image attachment" };
  const name = input.filename.toLowerCase();
  const signatureName = /(?:^|[_.-])(image\d{1,3}|logo|signature|sig|facebook|instagram|linkedin|twitter|youtube|whatsapp|telegram|icon)(?:[_.-]|$)/i.test(name);
  const tinyIcon = Boolean(input.width && input.height && input.width <= 128 && input.height <= 128 && input.size <= 150_000);
  const signatureShape = Boolean(input.width && input.height && input.width <= 900 && input.height <= 320 && input.size <= 300_000);
  if (input.referenced) return { kind: "inline", reason: "CID image referenced by HTML" };
  if (signatureName && input.size <= 500_000) return { kind: "signature", reason: "signature/logo filename pattern" };
  if (tinyIcon) return { kind: "signature", reason: "small icon dimensions" };
  if (input.disposition === "inline" && signatureShape) return { kind: "signature", reason: "small inline signature-shaped image" };
  if (input.disposition === "inline") return { kind: "uncertain", reason: "unreferenced inline image" };
  return { kind: "real", reason: "explicit image attachment" };
}

function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function imageDimensions(content: Buffer, contentType: string): { width?: number; height?: number } {
  if (contentType === "image/png" && content.length >= 24 && content.toString("ascii", 1, 4) === "PNG") {
    return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
  }
  if (contentType === "image/gif" && content.length >= 10) return { width: content.readUInt16LE(6), height: content.readUInt16LE(8) };
  if (contentType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < content.length) {
      if (content[offset] !== 0xff) { offset++; continue; }
      const marker = content[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { height: content.readUInt16BE(offset + 5), width: content.readUInt16BE(offset + 7) };
      }
      const length = content.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += length + 2;
    }
  }
  return {};
}

export function parsedMailToIncoming(parsed: ParsedMail, identity: Pick<IncomingMail, "uid" | "uidValidity" | "mailbox"> & Pick<IncomingMail, "accountId" | "accountLabel">): IncomingMail {
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const rawText = parsed.text?.trim() || (html ? htmlToReadableText(html) : "");
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const calendar = parsed.attachments.map((attachment) => attachment.contentType.toLowerCase() === "text/calendar" ? parseCalendar(attachment.content) : undefined).find(Boolean);
  return {
    ...identity,
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
    references,
    subject: parsed.subject || "(بدون موضوع)",
    from: addresses(parsed.from),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    replyTo: addresses(parsed.replyTo),
    receivedAt: parsed.date ?? new Date(),
    text: stripQuotedHistory(rawText),
    ...(html ? { html } : {}),
    attachments: parsed.attachments.map((a, i) => attachmentMeta(a, i, html)),
    ...(calendar ? { calendar } : {})
  };
}
