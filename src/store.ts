import { backup, DatabaseSync } from "node:sqlite";
import type { Analysis, IncomingMail, StoredMail } from "./domain/types.js";
import { deriveThreadKey } from "./mail/thread.js";

interface MailRow {
  id: number;
  uid: number;
  uid_validity: string;
  mailbox: string;
  message_id: string | null;
  thread_key: string | null;
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

export interface DurableJob {
  id: number;
  kind: string;
  mailId: number;
  payload: Record<string, unknown>;
  attempts: number;
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
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    this.applyMigration(1, `
      CREATE TABLE IF NOT EXISTS action_locks (
        mail_id INTEGER PRIMARY KEY REFERENCES mails(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        payload_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(kind, mail_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(state, available_at);
    `);
    this.applyMigration(2, `
      ALTER TABLE mails ADD COLUMN thread_key TEXT;
      CREATE INDEX mails_thread_state_idx ON mails(thread_key,state);
    `);
    this.applyMigration(3, `ALTER TABLE conversations ADD COLUMN prompt_message_id INTEGER;`);
    for (const row of this.db.prepare("SELECT id,payload_json FROM mails WHERE thread_key IS NULL").all() as unknown as Array<{ id: number; payload_json: string }>) {
      const mail = JSON.parse(row.payload_json) as IncomingMail;
      this.db.prepare("UPDATE mails SET thread_key=? WHERE id=?").run(deriveThreadKey(mail), row.id);
    }
    this.db.prepare("UPDATE mails SET state='failed',last_error='Recovered interrupted operation after restart',updated_at=CURRENT_TIMESTAMP WHERE state='processing'").run();
  }

  close(): void { this.db.close(); }
  async backup(path: string): Promise<void> { await backup(this.db, path); }

  private applyMigration(version: number, sql: string): void {
    const applied = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(version);
    if (applied) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(sql);
      this.db.prepare("INSERT INTO schema_migrations(version) VALUES(?)").run(version);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  acquireActionLock(mailId: number, action: string, token: string, ttlMs = 300_000): boolean {
    const now = Date.now();
    this.db.prepare("DELETE FROM action_locks WHERE expires_at<=?").run(now);
    const result = this.db.prepare("INSERT OR IGNORE INTO action_locks(mail_id,action,token,expires_at) VALUES(?,?,?,?)")
      .run(mailId, action, token, now + ttlMs);
    return result.changes === 1;
  }

  releaseActionLock(mailId: number, token: string, cooldownMs = 0): void {
    if (cooldownMs > 0) {
      this.db.prepare("UPDATE action_locks SET expires_at=? WHERE mail_id=? AND token=?").run(Date.now() + cooldownMs, mailId, token);
      return;
    }
    this.db.prepare("DELETE FROM action_locks WHERE mail_id=? AND token=?").run(mailId, token);
  }

  enqueueJob(kind: string, mailId: number, payload: Record<string, unknown> = {}): void {
    this.db.prepare(`INSERT INTO jobs(kind,mail_id,payload_json) VALUES(?,?,?)
      ON CONFLICT(kind,mail_id) DO UPDATE SET state=CASE WHEN jobs.state IN ('complete','failed') THEN jobs.state ELSE 'queued' END,
      payload_json=excluded.payload_json,available_at=0,updated_at=CURRENT_TIMESTAMP`)
      .run(kind, mailId, JSON.stringify(payload));
  }

  leaseJob(leaseMs = 120_000): DurableJob | undefined {
    const now = Date.now();
    this.db.prepare("UPDATE jobs SET state='queued',lease_until=NULL WHERE state='running' AND lease_until<=?").run(now);
    const row = this.db.prepare("SELECT * FROM jobs WHERE state='queued' AND available_at<=? ORDER BY id LIMIT 1").get(now) as any;
    if (!row) return undefined;
    const result = this.db.prepare("UPDATE jobs SET state='running',attempts=attempts+1,lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='queued'")
      .run(now + leaseMs, row.id);
    if (result.changes !== 1) return undefined;
    return { id: row.id, kind: row.kind, mailId: row.mail_id, payload: JSON.parse(row.payload_json), attempts: row.attempts + 1 };
  }

  completeJob(id: number): void { this.db.prepare("UPDATE jobs SET state='complete',lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id); }
  failJob(id: number, error: string, retryMs: number, terminal = false): void {
    this.db.prepare("UPDATE jobs SET state=?,lease_until=NULL,last_error=?,available_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(terminal ? "failed" : "queued", error, Date.now() + retryMs, id);
  }

  jobCounts(): Record<string, number> {
    const rows = this.db.prepare("SELECT state,count(*) count FROM jobs GROUP BY state").all() as unknown as Array<{ state: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.state, row.count]));
  }

  purgeCompleted(retentionDays: number): number {
    const result = this.db.prepare(`DELETE FROM mails WHERE state IN ('done','external_done')
      AND datetime(updated_at) < datetime('now', ?)`)
      .run(`-${retentionDays} days`);
    return Number(result.changes);
  }

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
    const threadKey = deriveThreadKey(mail);
    const existing = this.db.prepare("SELECT id FROM mails WHERE mailbox=? AND uid_validity=? AND uid=?")
      .get(mail.mailbox, mail.uidValidity, mail.uid) as { id: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE mails SET message_id=?,thread_key=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(mail.messageId ?? null, threadKey, JSON.stringify(mail), existing.id);
      return { id: existing.id, created: false };
    }
    const result = this.db.prepare(`
      INSERT INTO mails(uid,uid_validity,mailbox,message_id,thread_key,payload_json)
      VALUES(?,?,?,?,?,?)
    `).run(mail.uid, mail.uidValidity, mail.mailbox, mail.messageId ?? null, threadKey, JSON.stringify(mail));
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

  listPendingCards(): StoredMail[] {
    const representatives = new Map<string, StoredMail>();
    for (const mail of this.listPending()) {
      const key = this.threadKey(mail.id);
      const current = representatives.get(key);
      if (!current || mail.receivedAt > current.receivedAt || (mail.receivedAt.getTime() === current.receivedAt.getTime() && mail.id > current.id)) {
        representatives.set(key, mail);
      }
    }
    return [...representatives.values()].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id - b.id);
  }

  threadMembers(mailId: number, actionableOnly = true): StoredMail[] {
    const key = this.threadKey(mailId);
    const rows = this.db.prepare(`SELECT * FROM mails WHERE thread_key=? ${actionableOnly ? "AND state IN ('pending','failed','processing')" : ""} ORDER BY json_extract(payload_json,'$.receivedAt'),id`)
      .all(key) as unknown as MailRow[];
    return rows.map((row) => this.rowToMail(row));
  }

  threadRepresentative(mailId: number): StoredMail | undefined {
    const members = this.threadMembers(mailId);
    return members[members.length - 1];
  }

  private threadKey(mailId: number): string {
    const row = this.db.prepare("SELECT thread_key FROM mails WHERE id=?").get(mailId) as { thread_key: string | null } | undefined;
    return row?.thread_key ?? `mail:${mailId}`;
  }

  listKnownUids(mailbox: string, uidValidity: string): Set<number> {
    const rows = this.db.prepare("SELECT uid,payload_json FROM mails WHERE mailbox=? AND uid_validity=?")
      .all(mailbox, uidValidity) as unknown as Array<{ uid: number; payload_json: string }>;
    return new Set(rows.filter((row) => {
      const payload = JSON.parse(row.payload_json) as IncomingMail;
      return payload.attachments.every((attachment) => Boolean(attachment.classification));
    }).map((row) => row.uid));
  }

  listActionable(mailbox: string, uidValidity: string): StoredMail[] {
    return (this.db.prepare("SELECT * FROM mails WHERE mailbox=? AND uid_validity=? AND state IN ('pending','failed','processing') ORDER BY uid")
      .all(mailbox, uidValidity) as unknown as MailRow[]).map((row) => this.rowToMail(row));
  }

  listNonActionableWithTelegram(): StoredMail[] {
    return (this.db.prepare("SELECT * FROM mails WHERE state NOT IN ('pending','failed','processing') AND telegram_ids_json!='[]'")
      .all() as unknown as MailRow[]).map((row) => this.rowToMail(row));
  }

  counts(): { pending: number; pendingThreads: number; failed: number; processing: number; done: number; externalDone: number } {
    const rows = this.db.prepare("SELECT state,count(*) count FROM mails GROUP BY state").all() as unknown as Array<{ state: string; count: number }>;
    const count = (state: string) => rows.find((row) => row.state === state)?.count ?? 0;
    return { pending: count("pending"), pendingThreads: this.listPendingCards().length, failed: count("failed"), processing: count("processing"), done: count("done"), externalDone: count("external_done") };
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

  setThreadState(mailId: number, state: StoredMail["state"], error?: string): void {
    for (const member of this.threadMembers(mailId)) this.setState(member.id, state, error);
  }

  setConversation(userId: number, mailId: number, mode: string, replyAll: boolean, tone = "formal", draft?: string, metadata?: Record<string, unknown>, promptMessageId?: number): void {
    this.db.prepare(`INSERT INTO conversations(telegram_user_id,mail_id,mode,reply_all,tone,draft_text,metadata_json,prompt_message_id)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(telegram_user_id,mail_id) DO UPDATE SET mode=excluded.mode,
      reply_all=excluded.reply_all,tone=excluded.tone,draft_text=excluded.draft_text,metadata_json=excluded.metadata_json,
      prompt_message_id=excluded.prompt_message_id,updated_at=CURRENT_TIMESTAMP`)
      .run(userId, mailId, mode, replyAll ? 1 : 0, tone, draft ?? null, metadata ? JSON.stringify(metadata) : null, promptMessageId ?? null);
  }

  setConversationPrompt(userId: number, mailId: number, promptMessageId: number): void {
    this.db.prepare("UPDATE conversations SET prompt_message_id=?,updated_at=CURRENT_TIMESTAMP WHERE telegram_user_id=? AND mail_id=?")
      .run(promptMessageId, userId, mailId);
  }

  getConversation(userId: number, mailId?: number): { mailId: number; mode: string; replyAll: boolean; tone: string; draft?: string; metadata?: Record<string, unknown>; promptMessageId?: number } | undefined {
    const row = (mailId === undefined
      ? this.db.prepare("SELECT * FROM conversations WHERE telegram_user_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(userId)
      : this.db.prepare("SELECT * FROM conversations WHERE telegram_user_id=? AND mail_id=?").get(userId, mailId)) as any;
    if (!row) return undefined;
    return {
      mailId: row.mail_id, mode: row.mode, replyAll: Boolean(row.reply_all), tone: row.tone,
      ...(row.draft_text ? { draft: row.draft_text } : {}),
      ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> } : {}),
      ...(row.prompt_message_id ? { promptMessageId: row.prompt_message_id } : {})
    };
  }

  getConversationByPrompt(userId: number, promptMessageId: number): ReturnType<Store["getConversation"]> {
    const row = this.db.prepare("SELECT mail_id FROM conversations WHERE telegram_user_id=? AND prompt_message_id=? ORDER BY updated_at DESC LIMIT 1")
      .get(userId, promptMessageId) as { mail_id: number } | undefined;
    return row ? this.getConversation(userId, row.mail_id) : undefined;
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
