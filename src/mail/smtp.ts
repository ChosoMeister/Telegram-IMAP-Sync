import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import type { AppConfig } from "../config.js";
import type { ReplyDraft, StoredMail } from "../domain/types.js";

export class SmtpService {
  private transporter;
  constructor(private config: AppConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    });
  }

  async verify(): Promise<void> { await this.transporter.verify(); }

  async buildReply(mail: StoredMail, draft: ReplyDraft): Promise<Buffer> {
    return new MailComposer({
      from: this.config.SMTP_FROM,
      to: draft.to.map(formatAddress), cc: draft.cc.map(formatAddress),
      subject: draft.subject, text: draft.text, html: draft.html,
      inReplyTo: mail.messageId, references: [...mail.references, ...(mail.messageId ? [mail.messageId] : [])]
    }).compile().build();
  }

  async sendReply(mail: StoredMail, draft: ReplyDraft): Promise<Buffer> {
    if (this.config.APP_MODE !== "live") throw new Error("SMTP sending is disabled in dry-run mode");
    const raw = await this.buildReply(mail, draft);
    await this.transporter.sendMail({
      envelope: { from: this.config.SMTP_FROM, to: [...draft.to, ...draft.cc].map((address) => address.address) },
      raw
    });
    return raw;
  }

  async buildForward(mail: StoredMail, recipients: string[], note: string, source: Buffer): Promise<Buffer> {
    const parsed = await simpleParser(source);
    const header = [
      "---------- Forwarded message ---------",
      `From: ${mail.from.map(formatAddress).join(", ")}`,
      `Date: ${mail.receivedAt.toISOString()}`,
      `Subject: ${mail.subject}`,
      `To: ${mail.to.map(formatAddress).join(", ")}`
    ].join("\n");
    const original = mail.text || "[No extractable text]";
    const text = `${note.trim()}\n\n${header}\n\n${original}`;
    const html = `<div dir="auto">${escapeHtml(note.trim()).replace(/\n/g, "<br>")}</div><br><div>${escapeHtml(header).replace(/\n/g, "<br>")}</div><br><div dir="auto">${escapeHtml(original).replace(/\n/g, "<br>")}</div>`;
    const attachments = mail.attachments.filter((item) => item.isRealAttachment).flatMap((item) => {
      const originalAttachment = parsed.attachments[Number(item.partId)];
      return originalAttachment ? [{
        filename: originalAttachment.filename || item.filename,
        contentType: originalAttachment.contentType,
        content: originalAttachment.content
      }] : [];
    });
    return new MailComposer({
      from: this.config.SMTP_FROM, to: recipients,
      subject: /^(?:fw|fwd):/i.test(mail.subject) ? mail.subject : `Fwd: ${mail.subject}`,
      text, html, attachments
    }).compile().build();
  }

  async sendForward(mail: StoredMail, recipients: string[], note: string, source: Buffer): Promise<Buffer> {
    if (this.config.APP_MODE !== "live") throw new Error("SMTP sending is disabled in dry-run mode");
    const raw = await this.buildForward(mail, recipients, note, source);
    await this.transporter.sendMail({ envelope: { from: this.config.SMTP_FROM, to: recipients }, raw });
    return raw;
  }
}

function formatAddress(a: { name?: string; address: string }): string {
  return a.name ? `"${a.name.replace(/"/g, "\\\"")}" <${a.address}>` : a.address;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
