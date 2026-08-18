import { DatabaseSync } from "node:sqlite";
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
        telegram_user_id INTEGER PRIMARY KEY,
        mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        reply_all INTEGER NOT NULL DEFAULT 0,
        tone TEXT NOT NULL DEFAULT 'formal',
        draft_text TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  close(): void { this.db.close(); }

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

  setConversation(userId: number, mailId: number, mode: string, replyAll: boolean, tone = "formal", draft?: string): void {
    this.db.prepare(`INSERT INTO conversations(telegram_user_id,mail_id,mode,reply_all,tone,draft_text)
      VALUES(?,?,?,?,?,?) ON CONFLICT(telegram_user_id) DO UPDATE SET mail_id=excluded.mail_id,mode=excluded.mode,
      reply_all=excluded.reply_all,tone=excluded.tone,draft_text=excluded.draft_text,updated_at=CURRENT_TIMESTAMP`)
      .run(userId, mailId, mode, replyAll ? 1 : 0, tone, draft ?? null);
  }

  getConversation(userId: number): { mailId: number; mode: string; replyAll: boolean; tone: string; draft?: string } | undefined {
    const row = this.db.prepare("SELECT * FROM conversations WHERE telegram_user_id=?").get(userId) as any;
    if (!row) return undefined;
    return { mailId: row.mail_id, mode: row.mode, replyAll: Boolean(row.reply_all), tone: row.tone, ...(row.draft_text ? { draft: row.draft_text } : {}) };
  }

  clearConversation(userId: number): void { this.db.prepare("DELETE FROM conversations WHERE telegram_user_id=?").run(userId); }

  getKv(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  setKv(key: string, value: string): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

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
