import sanitizeHtml from "sanitize-html";
import type { Attachment, ParsedMail } from "mailparser";
import type { Address, IncomingMail, MailAttachment } from "../domain/types.js";

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
  const referenced = Boolean(attachment.cid && html?.includes(`cid:${attachment.cid}`));
  const likelySignatureImage = disposition === "inline" && referenced && attachment.size < 100_000;
  return {
    partId: String(index),
    filename: attachment.filename || `attachment-${index + 1}`,
    contentType: attachment.contentType,
    size: attachment.size,
    contentDisposition: disposition,
    ...(attachment.cid ? { contentId: attachment.cid } : {}),
    isRealAttachment: disposition === "attachment" || !likelySignatureImage
  };
}

export function parsedMailToIncoming(parsed: ParsedMail, identity: Pick<IncomingMail, "uid" | "uidValidity" | "mailbox">): IncomingMail {
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  const rawText = parsed.text?.trim() || (html ? htmlToReadableText(html) : "");
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
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
    attachments: parsed.attachments.map((a, i) => attachmentMeta(a, i, html))
  };
}
