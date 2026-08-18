import { backup, DatabaseSync } from "node:sqlite";
import type { Analysis, IncomingMail, StoredMail } from "./domain/types.js";

interface MailRow {
  id: number;
  uid: number;
  uid_validity: string;
  mailbox: string;
  message_id: string | null;
  state: StoredMail["state"];
  payload_json: string;
  analysis_json: string | null;
  telegram_ids_json: string;
  telegram_created_at: string | null;
  last_error: string | null;
}

export interface OutboundOperation {
  mailId: number;
  kind: "reply" | "forward";
  messageId: string;
  raw: Buffer;
  smtpAttempted: boolean;
  smtpAccepted: boolean;
  sentSaved: boolean;
  completed: boolean;
}

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mails (
        id INTEGER PRIMARY KEY,
        uid INTEGER NOT NULL,
        uid_validity TEXT NOT NULL,
        mailbox TEXT NOT NULL,
        message_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT NOT NULL,
        analysis_json TEXT,
        telegram_ids_json TEXT NOT NULL DEFAULT '[]',
        telegram_created_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mailbox, uid_validity, uid)
      );
      CREATE INDEX IF NOT EXISTS mails_state_idx ON mails(state);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        telegram_user_id INTEGER NOT NULL,
        mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        reply_all INTEGER NOT NULL DEFAULT 0,
        tone TEXT NOT NULL DEFAULT 'formal',
        draft_text TEXT,
        metadata_json TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(telegram_user_id, mail_id)
      );
      CREATE TABLE IF NOT EXISTS outbound_operations (
        mail_id INTEGER PRIMARY KEY REFERENCES mails(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        raw_blob BLOB NOT NULL,
        smtp_attempted INTEGER NOT NULL DEFAULT 0,
        smtp_accepted INTEGER NOT NULL DEFAULT 0,
        sent_saved INTEGER NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as unknown as Array<{ name: string }>;
    if (!conversationColumns.some((column) => column.name === "metadata_json")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN metadata_json TEXT");
    }
    const primaryKey = (this.db.prepare("PRAGMA table_info(conversations)").all() as unknown as Array<{ name: string; pk: number }>)
      .filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (primaryKey.length === 1 && primaryKey[0] === "telegram_user_id") {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE conversations_v2 (
          telegram_user_id INTEGER NOT NULL,
          mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          reply_all INTEGER NOT NULL DEFAULT 0,
          tone TEXT NOT NULL DEFAULT 'formal',
          draft_text TEXT,
          metadata_json TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(telegram_user_id, mail_id)
        );
        INSERT INTO conversations_v2 SELECT telegram_user_id,mail_id,mode,reply_all,tone,draft_text,metadata_json,updated_at FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_v2 RENAME TO conversations;
        COMMIT;
      `);
    }
    const outboundColumns = this.db.prepare("PRAGMA table_info(outbound_operations)").all() as unknown as Array<{ name: string }>;
    if (!outboundColumns.some((column) => column.name === "smtp_attempted")) {
      this.db.exec("ALTER TABLE outbound_operations ADD COLUMN smtp_attempted INTEGER NOT NULL DEFAULT 0");
    }
    this.db.prepare("UPDATE mails SET state='failed',last_error='Recovered interrupted operation after restart',updated_at=CURRENT_TIMESTAMP WHERE state='processing'").run();
  }

  close(): void { this.db.close(); }
  async backup(path: string): Promise<void> { await backup(this.db, path); }

  createOutbound(mailId: number, kind: "reply" | "forward", messageId: string, raw: Buffer): OutboundOperation {
    this.db.prepare("INSERT OR IGNORE INTO outbound_operations(mail_id,kind,message_id,raw_blob) VALUES(?,?,?,?)")
      .run(mailId, kind, messageId, raw);
    return this.getOutbound(mailId)!;
  }

  getOutbound(mailId: number): OutboundOperation | undefined {
    const row = this.db.prepare("SELECT * FROM outbound_operations WHERE mail_id=?").get(mailId) as any;
    if (!row) return undefined;
    return {
      mailId: row.mail_id, kind: row.kind, messageId: row.message_id, raw: Buffer.from(row.raw_blob),
      smtpAttempted: Boolean(row.smtp_attempted), smtpAccepted: Boolean(row.smtp_accepted), sentSaved: Boolean(row.sent_saved), completed: Boolean(row.completed)
    };
  }

  markOutbound(mailId: number, stage: "attempt" | "smtp" | "sent" | "complete"): void {
    const assignment = stage === "attempt" ? "smtp_attempted=1" : stage === "smtp" ? "smtp_attempted=1,smtp_accepted=1" : stage === "sent" ? "smtp_attempted=1,smtp_accepted=1,sent_saved=1" : "smtp_attempted=1,smtp_accepted=1,sent_saved=1,completed=1";
    this.db.prepare(`UPDATE outbound_operations SET ${assignment},updated_at=CURRENT_TIMESTAMP WHERE mail_id=?`).run(mailId);
  }

  upsertMail(mail: IncomingMail): { id: number; created: boolean } {
    const existing = this.db.prepare("SELECT id FROM mails WHERE mailbox=? AND uid_validity=? AND uid=?")
      .get(mail.mailbox, mail.uidValidity, mail.uid) as { id: number } | undefined;
    if (existing) return { id: existing.id, created: false };
    const result = this.db.prepare(`
      INSERT INTO mails(uid,uid_validity,mailbox,message_id,payload_json)
      VALUES(?,?,?,?,?)
    `).run(mail.uid, mail.uidValidity, mail.mailbox, mail.messageId ?? null, JSON.stringify(mail));
    return { id: Number(result.lastInsertRowid), created: true };
  }

  getMail(id: number): StoredMail | undefined {
    const row = this.db.prepare("SELECT * FROM mails WHERE id=?").get(id) as MailRow | undefined;
    return row ? this.rowToMail(row) : undefined;
  }

  listPending(): StoredMail[] {
    return (this.db.prepare("SELECT * FROM mails WHERE state IN ('pending','failed') ORDER BY json_extract(payload_json,'$.receivedAt'), id")
      .all() as unknown as MailRow[]).map((r) => this.rowToMail(r));
  }

  listKnownUids(mailbox: string, uidValidity: string): Set<number> {
    const rows = this.db.prepare("SELECT uid FROM mails WHERE mailbox=? AND uid_validity=?")
      .all(mailbox, uidValidity) as unknown as Array<{ uid: number }>;
    return new Set(rows.map((row) => row.uid));
  }

  listActionable(mailbox: string, uidValidity: string): StoredMail[] {
    return (this.db.prepare("SELECT * FROM mails WHERE mailbox=? AND uid_validity=? AND state IN ('pending','failed','processing') ORDER BY uid")
      .all(mailbox, uidValidity) as unknown as MailRow[]).map((row) => this.rowToMail(row));
  }

  listNonActionableWithTelegram(): StoredMail[] {
    return (this.db.prepare("SELECT * FROM mails WHERE state NOT IN ('pending','failed','processing') AND telegram_ids_json!='[]'")
      .all() as unknown as MailRow[]).map((row) => this.rowToMail(row));
  }

  counts(): { pending: number; failed: number; processing: number; done: number; externalDone: number } {
    const rows = this.db.prepare("SELECT state,count(*) count FROM mails GROUP BY state").all() as unknown as Array<{ state: string; count: number }>;
    const count = (state: string) => rows.find((row) => row.state === state)?.count ?? 0;
    return { pending: count("pending"), failed: count("failed"), processing: count("processing"), done: count("done"), externalDone: count("external_done") };
  }

  setAnalysis(id: number, analysis: Analysis): void {
    this.db.prepare("UPDATE mails SET analysis_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(analysis), id);
  }

  setTelegramMessages(id: number, ids: number[], createdAt = new Date()): void {
    this.db.prepare("UPDATE mails SET telegram_ids_json=?,telegram_created_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(ids), createdAt.toISOString(), id);
  }

  setState(id: number, state: StoredMail["state"], error?: string): void {
    this.db.prepare("UPDATE mails SET state=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(state, error ?? null, id);
  }

  setConversation(userId: number, mailId: number, mode: string, replyAll: boolean, tone = "formal", draft?: string, metadata?: Record<string, unknown>): void {
    this.db.prepare(`INSERT INTO conversations(telegram_user_id,mail_id,mode,reply_all,tone,draft_text,metadata_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(telegram_user_id,mail_id) DO UPDATE SET mode=excluded.mode,
      reply_all=excluded.reply_all,tone=excluded.tone,draft_text=excluded.draft_text,metadata_json=excluded.metadata_json,updated_at=CURRENT_TIMESTAMP`)
      .run(userId, mailId, mode, replyAll ? 1 : 0, tone, draft ?? null, metadata ? JSON.stringify(metadata) : null);
  }

  getConversation(userId: number, mailId?: number): { mailId: number; mode: string; replyAll: boolean; tone: string; draft?: string; metadata?: Record<string, unknown> } | undefined {
    const row = (mailId === undefined
      ? this.db.prepare("SELECT * FROM conversations WHERE telegram_user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(userId)
      : this.db.prepare("SELECT * FROM conversations WHERE telegram_user_id=? AND mail_id=?").get(userId, mailId)) as any;
    if (!row) return undefined;
    return {
      mailId: row.mail_id, mode: row.mode, replyAll: Boolean(row.reply_all), tone: row.tone,
      ...(row.draft_text ? { draft: row.draft_text } : {}),
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {})
    };
  }

  clearConversation(userId: number, mailId: number): void {
    this.db.prepare("DELETE FROM conversations WHERE telegram_user_id=? AND mail_id=?").run(userId, mailId);
  }

  getKv(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  deleteKv(key: string): void { this.db.prepare("DELETE FROM kv WHERE key=?").run(key); }

  private rowToMail(row: MailRow): StoredMail {
    const payload = JSON.parse(row.payload_json) as IncomingMail & { receivedAt: string };
    return {
      ...payload,
      receivedAt: new Date(payload.receivedAt),
      id: row.id,
      state: row.state,
      ...(row.analysis_json ? { analysis: JSON.parse(row.analysis_json) as Analysis } : {}),
      telegramMessageIds: JSON.parse(row.telegram_ids_json) as number[],
      ...(row.telegram_created_at ? { telegramCreatedAt: new Date(row.telegram_created_at) } : {}),
      ...(row.last_error ? { lastError: row.last_error } : {})
    };
  }
}
