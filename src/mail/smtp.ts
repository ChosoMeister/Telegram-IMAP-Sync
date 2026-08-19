import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import type { AppConfig } from "../config.js";
import type { ReplyDraft, StoredMail } from "../domain/types.js";

export type CalendarResponse = "accept" | "tentative" | "decline";

export class SmtpService {
  private transporter;
  private health: { ok?: boolean; lastSuccess?: string; lastError?: string } = {};
  constructor(private config: AppConfig) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    });
  }

  status(): Record<string, unknown> { return this.health; }
  async verify(): Promise<void> {
    try { await this.transporter.verify(); this.health = { ok: true, lastSuccess: new Date().toISOString() }; }
    catch (error) { this.health = { ok: false, lastError: error instanceof Error ? error.message : String(error) }; throw error; }
  }

  async buildReply(mail: StoredMail, draft: ReplyDraft, messageId?: string): Promise<Buffer> {
    return new MailComposer({
      ...(messageId ? { messageId } : {}),
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

  async buildForward(mail: StoredMail, recipients: string[], note: string, source: Buffer, messageId?: string): Promise<Buffer> {
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
      if (item.size > this.config.MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${item.filename} exceeds configured size limit`);
      const originalAttachment = parsed.attachments[Number(item.partId)];
      return originalAttachment ? [{
        filename: originalAttachment.filename || item.filename,
        contentType: originalAttachment.contentType,
        content: originalAttachment.content
      }] : [];
    });
    return new MailComposer({
      ...(messageId ? { messageId } : {}),
      from: this.config.SMTP_FROM, to: recipients,
      subject: /^(?:fw|fwd):/i.test(mail.subject) ? mail.subject : `Fwd: ${mail.subject}`,
      text, html, attachments
    }).compile().build();
  }

  async buildCalendarResponse(mail: StoredMail, response: CalendarResponse, messageId?: string): Promise<{ raw: Buffer; organizer: string }> {
    const event = mail.calendar;
    if (!event?.uid || !event.organizer?.address) throw new Error("Calendar UID or organizer is missing");
    const attendee = event.attendees.find((item) => item.address.toLowerCase() === this.config.SMTP_FROM.toLowerCase());
    if (!attendee) throw new Error("Configured sender is not an attendee of this invitation");
    const partstat = ({ accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED" } as const)[response];
    const label = ({ accept: "پذیرفته شد", tentative: "شاید", decline: "رد شد" } as const)[response];
    const ics = buildCalendarReply(mail, partstat, attendee);
    const raw = await new MailComposer({
      ...(messageId ? { messageId } : {}), from: this.config.SMTP_FROM, to: event.organizer.address,
      subject: `${label}: ${event.summary || mail.subject}`,
      text: `پاسخ تقویم: ${label}\n${event.summary || mail.subject}`,
      inReplyTo: mail.messageId, references: [...mail.references, ...(mail.messageId ? [mail.messageId] : [])],
      icalEvent: { filename: "reply.ics", method: "REPLY", content: ics }
    }).compile().build();
    return { raw, organizer: event.organizer.address };
  }

  async sendForward(mail: StoredMail, recipients: string[], note: string, source: Buffer): Promise<Buffer> {
    if (this.config.APP_MODE !== "live") throw new Error("SMTP sending is disabled in dry-run mode");
    const raw = await this.buildForward(mail, recipients, note, source);
    await this.transporter.sendMail({ envelope: { from: this.config.SMTP_FROM, to: recipients }, raw });
    return raw;
  }

  async sendRaw(recipients: string[], raw: Buffer): Promise<void> {
    if (this.config.APP_MODE !== "live") throw new Error("SMTP sending is disabled in dry-run mode");
    try {
      await this.transporter.sendMail({ envelope: { from: this.config.SMTP_FROM, to: recipients }, raw });
      this.health = { ok: true, lastSuccess: new Date().toISOString() };
    } catch (error) {
      this.health = { ok: false, lastError: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}

function buildCalendarReply(mail: StoredMail, partstat: "ACCEPTED" | "TENTATIVE" | "DECLINED", attendee: { name?: string; address: string }): string {
  const event = mail.calendar!;
  const attendeeName = attendee.name ? `;CN=${quoteIcsParam(attendee.name)}` : "";
  return [
    "BEGIN:VCALENDAR", "PRODID:-//Telegram IMAP Sync//Calendar Reply//FA", "VERSION:2.0", "METHOD:REPLY", "BEGIN:VEVENT",
    `UID:${escapeIcs(event.uid!)}`, `DTSTAMP:${toIcsUtc(new Date())}`, `SEQUENCE:${event.sequence ?? 0}`,
    ...(event.recurrenceId ? [`RECURRENCE-ID:${event.recurrenceId}`] : []),
    `ORGANIZER:mailto:${event.organizer!.address}`,
    `ATTENDEE${attendeeName};PARTSTAT=${partstat}:mailto:${attendee.address}`,
    "REQUEST-STATUS:2.0;Success", "END:VEVENT", "END:VCALENDAR", ""
  ].join("\r\n");
}

function toIcsUtc(value: Date): string { return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function escapeIcs(value: string): string { return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
function quoteIcsParam(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`; }

function formatAddress(a: { name?: string; address: string }): string {
  return a.name ? `"${a.name.replace(/"/g, "\\\"")}" <${a.address}>` : a.address;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
