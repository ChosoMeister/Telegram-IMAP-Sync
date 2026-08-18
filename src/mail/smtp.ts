import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
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
}

function formatAddress(a: { name?: string; address: string }): string {
  return a.name ? `"${a.name.replace(/"/g, "\\\"")}" <${a.address}>` : a.address;
}
