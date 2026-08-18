import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AppConfig } from "../config.js";
import type { IncomingMail, MailAttachment, StoredMail } from "../domain/types.js";
import type { Logger } from "../logger.js";
import { parsedMailToIncoming } from "./content.js";

export class ImapService {
  private client?: ImapFlow;
  private stopped = false;
  constructor(private config: AppConfig, private logger: Logger) {}

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.IMAP_HOST, port: this.config.IMAP_PORT, secure: this.config.IMAP_SECURE,
      auth: { user: this.config.IMAP_USER, pass: this.config.IMAP_PASSWORD },
      logger: false, emitLogs: false
    });
  }

  async discoverMailboxes(): Promise<{ capabilities: string[]; mailboxes: Array<{ path: string; specialUse?: string }> }> {
    const client = this.createClient();
    try {
      await client.connect();
      const boxes = await client.list();
      return {
        capabilities: [...client.capabilities.keys()].sort(),
        mailboxes: boxes.map((box) => ({ path: box.path, ...(box.specialUse ? { specialUse: box.specialUse } : {}) }))
      };
    } finally { await client.logout().catch(() => undefined); }
  }

  async connect(): Promise<void> {
    this.client = this.createClient();
    this.client.on("error", (error) => this.logger.error("IMAP error", { error: error.message }));
    await this.client.connect();
    await this.client.mailboxOpen(this.config.IMAP_MAILBOX);
  }

  async scanInbox(): Promise<IncomingMail[]> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(this.config.IMAP_MAILBOX);
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.exists === 0) return [];
      const mails: IncomingMail[] = [];
      const start = this.config.TEST_IMPORT_LIMIT > 0 ? Math.max(1, mailbox.exists - this.config.TEST_IMPORT_LIMIT + 1) : 1;
      for await (const message of client.fetch(`${start}:*`, { uid: true, source: true })) {
        if (!message.source || !message.uid) continue;
        const parsed = await simpleParser(message.source);
        mails.push(parsedMailToIncoming(parsed, {
          uid: message.uid,
          uidValidity: String(mailbox.uidValidity),
          mailbox: this.config.IMAP_MAILBOX
        }));
      }
      return mails;
    } finally { lock.release(); }
  }

  async archive(mail: StoredMail): Promise<void> {
    if (!this.config.IMAP_ARCHIVE_MAILBOX) throw new Error("IMAP_ARCHIVE_MAILBOX is not configured");
    if (this.config.APP_MODE !== "live") throw new Error("Archive is disabled in dry-run mode");
    const client = this.requireClient();
    const lock = await client.getMailboxLock(mail.mailbox);
    try {
      await client.messageMove({ uid: mail.uid }, this.config.IMAP_ARCHIVE_MAILBOX, { uid: true });
      const remains = await client.search({ uid: mail.uid }, { uid: true });
      if (remains && remains.length) throw new Error("IMAP move was not verified; message remains in Inbox");
    } finally { lock.release(); }
  }

  async appendSent(content: Buffer, sentAt = new Date()): Promise<void> {
    if (this.config.APP_MODE !== "live") throw new Error("Saving to Sent is disabled in dry-run mode");
    const client = this.requireClient();
    let mailbox = this.config.IMAP_SENT_MAILBOX;
    if (!mailbox) {
      const boxes = await client.list();
      mailbox = boxes.find((box) => box.specialUse === "\\Sent")?.path;
    }
    if (!mailbox) throw new Error("Sent mailbox was not found; configure IMAP_SENT_MAILBOX");
    const result = await client.append(mailbox, content, ["\\Seen"], sentAt);
    if (!result) throw new Error("Exchange did not confirm saving the reply to Sent");
  }

  async fetchAttachment(mail: StoredMail, attachment: MailAttachment): Promise<Buffer> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(mail.mailbox);
    try {
      const fetched = await client.fetchOne(mail.uid, { source: true }, { uid: true });
      if (!fetched || !fetched.source) throw new Error("Message source is unavailable");
      const parsed = await simpleParser(fetched.source);
      const match = parsed.attachments[Number(attachment.partId)];
      if (!match) throw new Error("Attachment no longer exists");
      return match.content;
    } finally { lock.release(); }
  }

  async waitForChanges(onChange: () => Promise<void>): Promise<void> {
    const client = this.requireClient();
    client.on("exists", () => { void onChange(); });
    while (!this.stopped && client.usable) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.client?.usable) await this.client.logout().catch(() => undefined);
  }
  private requireClient(): ImapFlow { if (!this.client?.usable) throw new Error("IMAP is not connected"); return this.client; }
}
