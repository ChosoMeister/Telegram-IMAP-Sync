import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AppConfig } from "../config.js";
import type { IncomingMail, MailAttachment, StoredMail } from "../domain/types.js";
import type { Logger } from "../logger.js";
import type { MailRule } from "../rules.js";
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
    if (this.client?.usable) return;
    if (this.client) await this.client.logout().catch(() => undefined);
    this.client = this.createClient();
    this.client.on("error", (error) => this.logger.error("IMAP error", { error: error.message }));
    await this.client.connect();
    await this.client.mailboxOpen(this.config.IMAP_MAILBOX);
  }

  isConnected(): boolean { return Boolean(this.client?.usable && this.client.mailbox); }

  mailboxIdentity(): { path: string; uidValidity: string } {
    const client = this.requireClient();
    if (!client.mailbox) throw new Error("IMAP mailbox is not open");
    return { path: this.config.IMAP_MAILBOX, uidValidity: String(client.mailbox.uidValidity) };
  }

  async listInboxUids(): Promise<Set<number>> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(this.config.IMAP_MAILBOX);
    try { return new Set((await client.search({ all: true }, { uid: true })) || []); }
    finally { lock.release(); }
  }

  async ensureMailboxes(paths: string[]): Promise<void> {
    if (this.config.APP_MODE !== "live" || !paths.length) return;
    const client = this.requireClient();
    const existing = new Set((await client.list()).map((box) => box.path.toLowerCase()));
    const expanded = new Set<string>();
    for (const path of paths) {
      const parts = path.split("/");
      for (let index = 1; index <= parts.length; index++) expanded.add(parts.slice(0, index).join("/"));
    }
    for (const path of [...expanded].sort((a, b) => a.split("/").length - b.split("/").length)) {
      if (!existing.has(path.toLowerCase())) {
        await client.mailboxCreate(path);
        existing.add(path.toLowerCase());
      }
    }
  }

  async applyRule(mail: StoredMail, rule: MailRule): Promise<void> {
    if (this.config.APP_MODE !== "live") throw new Error("Mail rules are disabled in dry-run mode");
    const client = this.requireClient();
    const lock = await client.getMailboxLock(mail.mailbox);
    try {
      const query = { uid: mail.uid };
      const addFlags = [rule.actions.markRead ? "\\Seen" : undefined, rule.actions.flagged === true ? "\\Flagged" : undefined].filter((value): value is string => Boolean(value));
      if (addFlags.length) await client.messageFlagsAdd(query, addFlags, { uid: true });
      if (rule.actions.flagged === false) await client.messageFlagsRemove(query, ["\\Flagged"], { uid: true });
      if (rule.actions.copyTo) await client.messageCopy(query, rule.actions.copyTo, { uid: true });
      if (rule.actions.moveTo) {
        await client.messageMove(query, rule.actions.moveTo, { uid: true });
        const remains = await client.search(query, { uid: true });
        if (remains && remains.length) throw new Error("Rule move was not verified; message remains in Inbox");
      }
    } finally { lock.release(); }
  }

  async scanInbox(knownUids: ReadonlySet<number> = new Set()): Promise<IncomingMail[]> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(this.config.IMAP_MAILBOX);
    try {
      const mailbox = client.mailbox;
      if (!mailbox || mailbox.exists === 0) return [];
      const allUids = await client.search({ all: true }, { uid: true });
      const candidateUids = (allUids || []).filter((uid) => !knownUids.has(uid));
      const selectedUids = this.config.TEST_IMPORT_LIMIT > 0 ? candidateUids.slice(-this.config.TEST_IMPORT_LIMIT) : candidateUids;
      if (!selectedUids.length) return [];
      const mails: IncomingMail[] = [];
      for await (const message of client.fetch(selectedUids.join(","), { uid: true, source: true }, { uid: true })) {
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

  async sentContainsMessageId(messageId: string): Promise<boolean> {
    const client = this.requireClient();
    let mailbox = this.config.IMAP_SENT_MAILBOX;
    if (!mailbox) mailbox = (await client.list()).find((box) => box.specialUse === "\\Sent")?.path;
    if (!mailbox) return false;
    const lock = await client.getMailboxLock(mailbox);
    try {
      const normalized = messageId.replace(/^<|>$/g, "");
      const found = await client.search({ header: { "message-id": normalized } }, { uid: true });
      return Boolean(found && found.length);
    } finally { lock.release(); }
  }

  async fetchAttachment(mail: StoredMail, attachment: MailAttachment): Promise<Buffer> {
    if (attachment.size > this.config.MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds configured ${this.config.MAX_ATTACHMENT_BYTES}-byte limit`);
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

  async findThread(mail: StoredMail): Promise<IncomingMail[]> {
    const client = this.requireClient();
    const identifiers = [...new Set([mail.messageId].filter((value): value is string => Boolean(value)))]
      .map((value) => value.replace(/^<|>$/g, ""));
    const subject = mail.subject.replace(/^\s*(?:re|fw|fwd)\s*:\s*/i, "").trim();
    const boxes = await client.list();
    const archive = this.config.IMAP_ARCHIVE_MAILBOX ?? boxes.find((box) => box.specialUse === "\\Archive")?.path;
    const sent = this.config.IMAP_SENT_MAILBOX ?? boxes.find((box) => box.specialUse === "\\Sent")?.path;
    const paths = [...new Set([this.config.IMAP_MAILBOX, archive, sent].filter((value): value is string => Boolean(value)))];
    const sources: Array<{ source: Buffer; uid: number; uidValidity: string; mailbox: string }> = [];
    for (const path of paths) {
      const lookup = this.createClient();
      try {
        await lookup.connect();
        const lock = await lookup.getMailboxLock(path);
        try {
        const queries: any[] = identifiers.flatMap((id) => [
          { header: { "message-id": id } }, { header: { "in-reply-to": id } }, { header: { references: id } }
        ]);
        if (subject) queries.push({ subject });
        if (!queries.length) continue;
        const foundSet = new Set<number>();
        for (const criteria of queries) {
          for (const uid of await lookup.search(criteria, { uid: true }) || []) foundSet.add(uid);
          if (!lookup.usable) throw new Error("IMAP disconnected during thread search");
          if (foundSet.size >= this.config.THREAD_MAX_MESSAGES) break;
        }
        const found = [...foundSet].sort((a, b) => a - b).slice(-this.config.THREAD_MAX_MESSAGES);
        const mailbox = lookup.mailbox;
        if (!found.length || !mailbox) continue;
        for await (const message of lookup.fetch(found.join(","), { uid: true, source: true }, { uid: true })) {
          if (!message.source || !message.uid) continue;
          sources.push({ source: message.source, uid: message.uid, uidValidity: String(mailbox.uidValidity), mailbox: path });
        }
        } finally { lock.release(); }
        this.logger.debug("Thread mailbox searched", { sourceMailId: mail.id, candidateCount: sources.length });
      } finally { if (lookup.usable) await lookup.logout().catch(() => undefined); }
      if (sources.length >= this.config.THREAD_MAX_MESSAGES) break;
    }
    const result: IncomingMail[] = [];
    const seen = new Set<string>();
    for (const item of sources.slice(-this.config.THREAD_MAX_MESSAGES)) {
      const parsed = await simpleParser(item.source);
      const key = parsed.messageId ?? `${item.mailbox}:${item.uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(parsedMailToIncoming(parsed, { uid: item.uid, uidValidity: item.uidValidity, mailbox: item.mailbox }));
    }
    this.logger.debug("Thread sources parsed", { sourceMailId: mail.id, messageCount: result.length });
    return result.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  }

  async fetchSource(mail: StoredMail): Promise<Buffer> {
    const client = this.requireClient();
    const lock = await client.getMailboxLock(mail.mailbox);
    try {
      const fetched = await client.fetchOne(mail.uid, { source: true }, { uid: true });
      if (!fetched || !fetched.source) throw new Error("Message source is unavailable");
      return fetched.source;
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
