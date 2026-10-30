import { backup, DatabaseSync } from "node:sqlite";
import type { Analysis, AutomationDecision, AutomationPolicy, IncomingMail, LearnedRule, LearnedRuleEffect, LearnedRuleScope, MailTask, MemoryRecord, StoredMail } from "./domain/types.js";
import { deriveThreadKey } from "./mail/thread.js";

interface MailRow {
  id: number;
  account_id: string;
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
  kind: "reply" | "forward" | "calendar_accept" | "calendar_tentative" | "calendar_decline";
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

export interface TelegramMessageReference {
  chatId: number;
  messageId: number;
  mailId: number;
  role: "card" | "prompt" | "result";
  scopeMailIds: number[];
  active: boolean;
}

export interface TelegramCommand {
  id: number;
  updateId: number;
  userId: number;
  chatId: number;
  messageId: number;
  replyToMessageId?: number;
  text?: string;
  voice?: Record<string, unknown>;
  attempts: number;
}

export interface StoredConversationPlan {
  id: number;
  chatId: number;
  messageId: number;
  mailId: number;
  requestText: string;
  scopeMailIds: number[];
  plan: Record<string, unknown>;
  state: "planned" | "waiting" | "running" | "complete" | "failed" | "cancelled";
}

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly primaryAccountId = "primary", private readonly primaryAccountLabel = "Primary") {
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
    const accountMigration = this.db.prepare("SELECT 1 FROM schema_migrations WHERE version=4").get();
    if (!accountMigration) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec("ALTER TABLE mails ADD COLUMN account_id TEXT NOT NULL DEFAULT 'primary'");
        this.db.prepare("UPDATE mails SET account_id=?,mailbox=?||'::'||mailbox,thread_key=?||':'||thread_key")
          .run(this.primaryAccountId, this.primaryAccountId, this.primaryAccountId);
        this.db.prepare("INSERT INTO schema_migrations(version) VALUES(4)").run();
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    this.applyMigration(5, `
      CREATE TABLE IF NOT EXISTS learned_rules (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('sender','sender_subject','domain')),
        sender_email TEXT NOT NULL DEFAULT '',
        sender_domain TEXT NOT NULL DEFAULT '',
        subject_pattern TEXT NOT NULL DEFAULT '',
        effect TEXT NOT NULL CHECK(effect IN ('importance','not_mine','informational')),
        effect_value TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        confirmation_count INTEGER NOT NULL DEFAULT 1,
        source_mail_id INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id,scope,sender_email,sender_domain,subject_pattern,effect)
      );
      CREATE INDEX learned_rules_match_idx ON learned_rules(enabled,account_id,scope,sender_email,sender_domain);
      CREATE TABLE IF NOT EXISTS learned_rule_events (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER REFERENCES learned_rules(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    this.applyMigration(6, `
      CREATE TABLE telegram_message_refs (
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('card','prompt','result')),
        scope_mail_ids_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(chat_id,message_id)
      );
      CREATE INDEX telegram_message_refs_mail_idx ON telegram_message_refs(mail_id,active);
      CREATE TABLE telegram_commands (
        id INTEGER PRIMARY KEY,
        update_id INTEGER NOT NULL UNIQUE,
        telegram_user_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        reply_to_message_id INTEGER,
        text TEXT,
        voice_json TEXT,
        state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX telegram_commands_ready_idx ON telegram_commands(state,available_at);
    `);
    this.applyMigration(7, `
      CREATE TABLE conversation_plans (
        id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        message_id INTEGER NOT NULL,
        mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        request_text TEXT NOT NULL,
        scope_mail_ids_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','waiting','running','complete','failed','cancelled')),
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id,message_id)
      );
      CREATE TABLE conversation_tool_results (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL REFERENCES conversation_plans(id) ON DELETE CASCADE,
        action_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('complete','failed','skipped','waiting_confirmation')),
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(plan_id,action_index)
      );
      CREATE INDEX conversation_plans_mail_idx ON conversation_plans(mail_id,created_at);
    `);
    this.applyMigration(8, `
      CREATE TABLE assistant_memories (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('preference','role','correction','pattern','exception','permission')),
        memory_key TEXT NOT NULL,
        statement TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('global','account')),
        account_id TEXT NOT NULL DEFAULT '',
        confidence TEXT NOT NULL CHECK(confidence IN ('confirmed','inferred')),
        source TEXT NOT NULL CHECK(source IN ('user','model','migration')),
        source_mail_id INTEGER REFERENCES mails(id) ON DELETE SET NULL,
        source_plan_id INTEGER REFERENCES conversation_plans(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','disabled')),
        supersedes_id INTEGER REFERENCES assistant_memories(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX assistant_memories_active_key_idx
        ON assistant_memories(kind,memory_key,scope,account_id) WHERE status='active';
      CREATE INDEX assistant_memories_guidance_idx ON assistant_memories(status,confidence,scope,account_id);
    `);
    this.applyMigration(9, `
      CREATE TABLE mail_tasks (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('open','waiting','done','cancelled')),
        mail_ids_json TEXT NOT NULL,
        due_at INTEGER,
        timezone TEXT NOT NULL,
        reminder_state TEXT NOT NULL DEFAULT 'none' CHECK(reminder_state IN ('none','pending','running','delivered','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        last_error TEXT,
        telegram_message_id INTEGER,
        dedupe_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX mail_tasks_due_idx ON mail_tasks(reminder_state,due_at,available_at);
      CREATE INDEX mail_tasks_state_idx ON mail_tasks(state,account_id);
    `);
    this.applyMigration(10, `
      CREATE TABLE automation_policies (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('informational','newsletter','marketing')),
        action TEXT NOT NULL CHECK(action='archive'),
        scope TEXT NOT NULL CHECK(scope IN ('global','account')),
        account_id TEXT NOT NULL DEFAULT '',
        exceptions_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused')),
        source TEXT NOT NULL CHECK(source='user'),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE automation_decisions (
        id INTEGER PRIMARY KEY,
        mail_id INTEGER NOT NULL REFERENCES mails(id) ON DELETE CASCADE,
        policy_id INTEGER NOT NULL REFERENCES automation_policies(id) ON DELETE CASCADE,
        outcome TEXT NOT NULL CHECK(outcome IN ('would_archive','executed','skipped','failed')),
        reason TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(mail_id,policy_id)
      );
      CREATE INDEX automation_policies_match_idx ON automation_policies(status,scope,account_id,category);
      CREATE INDEX automation_decisions_mail_idx ON automation_decisions(mail_id,id);
    `);
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
      ON CONFLICT(kind,mail_id) DO UPDATE SET
      state=CASE
        WHEN jobs.state='complete' THEN jobs.state
        WHEN jobs.state='failed' THEN jobs.state
        ELSE 'queued'
      END,
      payload_json=excluded.payload_json,
      available_at=CASE WHEN jobs.state='failed' THEN jobs.available_at ELSE 0 END,
      updated_at=CURRENT_TIMESTAMP`)
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

  failureSummary(limit = 10): Array<{ kind: "mail" | "job"; id: number; subject?: string; error?: string }> {
    const mails = this.db.prepare("SELECT id,payload_json,last_error FROM mails WHERE state='failed' ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as Array<{ id: number; payload_json: string; last_error: string | null }>;
    const jobs = this.db.prepare("SELECT id,kind,last_error FROM jobs WHERE state='failed' ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as Array<{ id: number; kind: string; last_error: string | null }>;
    return [
      ...mails.map((row) => ({ kind: "mail" as const, id: row.id, subject: (JSON.parse(row.payload_json) as IncomingMail).subject, ...(row.last_error ? { error: row.last_error } : {}) })),
      ...jobs.map((row) => ({ kind: "job" as const, id: row.id, subject: row.kind, ...(row.last_error ? { error: row.last_error } : {}) }))
    ].slice(0, limit);
  }

  purgeCompleted(retentionDays: number): number {
    const result = this.db.prepare(`DELETE FROM mails WHERE state IN ('done','external_done')
      AND datetime(updated_at) < datetime('now', ?)`)
      .run(`-${retentionDays} days`);
    return Number(result.changes);
  }

  createOutbound(mailId: number, kind: OutboundOperation["kind"], messageId: string, raw: Buffer): OutboundOperation {
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
    const accountId = mail.accountId ?? this.primaryAccountId;
    const storageMailbox = `${accountId}::${mail.mailbox}`;
    const threadKey = `${accountId}:${deriveThreadKey(mail)}`;
    const existing = this.db.prepare("SELECT id FROM mails WHERE account_id=? AND mailbox=? AND uid_validity=? AND uid=?")
      .get(accountId, storageMailbox, mail.uidValidity, mail.uid) as { id: number } | undefined;
    if (existing) {
      this.db.prepare("UPDATE mails SET message_id=?,thread_key=?,payload_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(mail.messageId ?? null, threadKey, JSON.stringify(mail), existing.id);
      return { id: existing.id, created: false };
    }
    const result = this.db.prepare(`
      INSERT INTO mails(uid,uid_validity,mailbox,message_id,thread_key,payload_json,account_id)
      VALUES(?,?,?,?,?,?,?)
    `).run(mail.uid, mail.uidValidity, storageMailbox, mail.messageId ?? null, threadKey, JSON.stringify(mail), accountId);
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

  searchMails(query: string, limit = 5): StoredMail[] {
    const tokens = query.trim().toLocaleLowerCase("fa-IR").split(/\s+/u).filter((token) => token.length >= 2).slice(0, 8);
    if (!tokens.length) return [];
    const rows = this.db.prepare(`SELECT * FROM mails
      ORDER BY CASE WHEN state IN ('pending','failed','processing') THEN 0 ELSE 1 END,
      json_extract(payload_json,'$.receivedAt') DESC,id DESC LIMIT 500`).all() as unknown as MailRow[];
    return rows.map((row) => this.rowToMail(row)).filter((mail) => {
      const value = [mail.subject, mail.text, ...mail.from.flatMap((item) => [item.name ?? "", item.address]),
        ...mail.to.flatMap((item) => [item.name ?? "", item.address]), mail.analysis?.summaryFa ?? ""].join("\n").toLocaleLowerCase("fa-IR");
      return tokens.every((token) => value.includes(token));
    }).slice(0, Math.max(1, Math.min(limit, 20)));
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

  listKnownUids(accountId: string, mailbox: string, uidValidity: string): Set<number> {
    const rows = this.db.prepare("SELECT uid,payload_json FROM mails WHERE account_id=? AND mailbox=? AND uid_validity=?")
      .all(accountId, `${accountId}::${mailbox}`, uidValidity) as unknown as Array<{ uid: number; payload_json: string }>;
    return new Set(rows.filter((row) => {
      const payload = JSON.parse(row.payload_json) as IncomingMail;
      const needsCalendarRefresh = payload.attachments.some((attachment) => attachment.contentType.toLowerCase() === "text/calendar") && payload.calendar?.parserVersion !== 1;
      return !needsCalendarRefresh && payload.attachments.every((attachment) => Boolean(attachment.classification));
    }).map((row) => row.uid));
  }

  listActionable(accountId: string, mailbox: string, uidValidity: string): StoredMail[] {
    return (this.db.prepare("SELECT * FROM mails WHERE account_id=? AND mailbox=? AND uid_validity=? AND state IN ('pending','failed','processing') ORDER BY uid")
      .all(accountId, `${accountId}::${mailbox}`, uidValidity) as unknown as MailRow[]).map((row) => this.rowToMail(row));
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

  saveLearnedRule(input: {
    accountId: string; scope: LearnedRuleScope; senderEmail?: string; senderDomain?: string;
    subjectPattern?: string; effect: LearnedRuleEffect; effectValue?: string; sourceMailId?: number;
  }): LearnedRule {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO learned_rules(account_id,scope,sender_email,sender_domain,subject_pattern,effect,effect_value,source_mail_id)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,scope,sender_email,sender_domain,subject_pattern,effect) DO UPDATE SET
          effect_value=excluded.effect_value,enabled=1,confirmation_count=learned_rules.confirmation_count+1,
          source_mail_id=excluded.source_mail_id,updated_at=CURRENT_TIMESTAMP`)
        .run(input.accountId, input.scope, input.senderEmail ?? "", input.senderDomain ?? "",
          input.subjectPattern ?? "", input.effect, input.effectValue ?? null, input.sourceMailId ?? null);
      const row = this.db.prepare(`SELECT * FROM learned_rules WHERE account_id=? AND scope=? AND sender_email=?
        AND sender_domain=? AND subject_pattern=? AND effect=?`)
        .get(input.accountId, input.scope, input.senderEmail ?? "", input.senderDomain ?? "", input.subjectPattern ?? "", input.effect) as any;
      this.db.prepare("INSERT INTO learned_rule_events(rule_id,action,details_json) VALUES(?, 'confirmed', ?)")
        .run(row.id, JSON.stringify({ effectValue: input.effectValue, sourceMailId: input.sourceMailId }));
      this.db.exec("COMMIT");
      return this.rowToLearnedRule(row);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listLearnedRules(includeDisabled = true): LearnedRule[] {
    const rows = this.db.prepare(`SELECT * FROM learned_rules ${includeDisabled ? "" : "WHERE enabled=1"} ORDER BY enabled DESC,updated_at DESC,id DESC`).all() as any[];
    return rows.map((row) => this.rowToLearnedRule(row));
  }

  setLearnedRuleEnabled(id: number, enabled: boolean): LearnedRule | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare("UPDATE learned_rules SET enabled=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(enabled ? 1 : 0, id);
      if (!result.changes) { this.db.exec("COMMIT"); return undefined; }
      this.db.prepare("INSERT INTO learned_rule_events(rule_id,action,details_json) VALUES(?,?, '{}')").run(id, enabled ? "enabled" : "disabled");
      const row = this.db.prepare("SELECT * FROM learned_rules WHERE id=?").get(id) as any;
      this.db.exec("COMMIT");
      return row ? this.rowToLearnedRule(row) : undefined;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getLearnedRule(id: number): LearnedRule | undefined {
    const row = this.db.prepare("SELECT * FROM learned_rules WHERE id=?").get(id) as any;
    return row ? this.rowToLearnedRule(row) : undefined;
  }

  private rowToLearnedRule(row: any): LearnedRule {
    return {
      id: row.id, accountId: row.account_id, scope: row.scope, effect: row.effect,
      enabled: Boolean(row.enabled), confirmationCount: row.confirmation_count,
      createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.sender_email ? { senderEmail: row.sender_email } : {}),
      ...(row.sender_domain ? { senderDomain: row.sender_domain } : {}),
      ...(row.subject_pattern ? { subjectPattern: row.subject_pattern } : {}),
      ...(row.effect_value ? { effectValue: row.effect_value } : {}),
      ...(row.source_mail_id ? { sourceMailId: row.source_mail_id } : {})
    };
  }

  retryAnalysis(id: number): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE mails SET analysis_json=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
      const result = this.db.prepare(`UPDATE jobs SET state='queued',attempts=0,available_at=0,lease_until=NULL,last_error=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE kind='analyze' AND mail_id=? AND state!='running'`).run(id);
      if (result.changes === 0) this.db.prepare("INSERT OR IGNORE INTO jobs(kind,mail_id,payload_json) VALUES('analyze',?,'{}')").run(id);
      const queued = Boolean(this.db.prepare("SELECT 1 FROM jobs WHERE kind='analyze' AND mail_id=? AND state='queued'").get(id));
      this.db.exec("COMMIT");
      return queued;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setTelegramMessages(id: number, ids: number[], createdAt = new Date()): void {
    this.db.prepare("UPDATE mails SET telegram_ids_json=?,telegram_created_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(JSON.stringify(ids), createdAt.toISOString(), id);
  }

  registerTelegramMessage(input: Omit<TelegramMessageReference, "active">): void {
    this.db.prepare(`INSERT INTO telegram_message_refs(chat_id,message_id,mail_id,role,scope_mail_ids_json)
      VALUES(?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET
      mail_id=excluded.mail_id,role=excluded.role,scope_mail_ids_json=excluded.scope_mail_ids_json,
      active=1,updated_at=CURRENT_TIMESTAMP`)
      .run(input.chatId, input.messageId, input.mailId, input.role, JSON.stringify(input.scopeMailIds));
  }

  deactivateTelegramMessage(chatId: number, messageId: number): void {
    this.db.prepare("UPDATE telegram_message_refs SET active=0,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=?")
      .run(chatId, messageId);
  }

  resolveTelegramMessage(chatId: number, messageId: number): TelegramMessageReference | undefined {
    const row = this.db.prepare("SELECT * FROM telegram_message_refs WHERE chat_id=? AND message_id=?")
      .get(chatId, messageId) as any;
    if (!row) return undefined;
    return { chatId: row.chat_id, messageId: row.message_id, mailId: row.mail_id, role: row.role,
      scopeMailIds: JSON.parse(row.scope_mail_ids_json) as number[], active: Boolean(row.active) };
  }

  backfillTelegramCardReferences(chatId: number): number {
    let inserted = 0;
    for (const row of this.db.prepare("SELECT id,telegram_ids_json FROM mails WHERE telegram_ids_json!='[]'").all() as unknown as Array<{ id: number; telegram_ids_json: string }>) {
      const messageId = (JSON.parse(row.telegram_ids_json) as number[])[0];
      if (!messageId || this.resolveTelegramMessage(chatId, messageId)) continue;
      this.registerTelegramMessage({ chatId, messageId, mailId: row.id, role: "card",
        scopeMailIds: this.threadMembers(row.id).map((mail) => mail.id) });
      inserted++;
    }
    return inserted;
  }

  enqueueTelegramCommand(input: { updateId: number; userId: number; chatId: number; messageId: number; replyToMessageId?: number; text?: string; voice?: Record<string, unknown> }): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO telegram_commands
      (update_id,telegram_user_id,chat_id,message_id,reply_to_message_id,text,voice_json) VALUES(?,?,?,?,?,?,?)`)
      .run(input.updateId, input.userId, input.chatId, input.messageId, input.replyToMessageId ?? null,
        input.text ?? null, input.voice ? JSON.stringify(input.voice) : null);
    return result.changes === 1;
  }

  leaseTelegramCommand(leaseMs = 120_000): TelegramCommand | undefined {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE telegram_commands SET state='queued',lease_until=NULL WHERE state='running' AND lease_until<=?").run(now);
      const row = this.db.prepare(`SELECT * FROM telegram_commands WHERE state='queued' AND available_at<=?
        ORDER BY id LIMIT 1`).get(now) as any;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      this.db.prepare(`UPDATE telegram_commands SET state='running',attempts=attempts+1,lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(now + leaseMs, row.id);
      this.db.exec("COMMIT");
      return { id: row.id, updateId: row.update_id, userId: row.telegram_user_id, chatId: row.chat_id,
        messageId: row.message_id, ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
        ...(row.text ? { text: row.text } : {}), ...(row.voice_json ? { voice: JSON.parse(row.voice_json) as Record<string, unknown> } : {}),
        attempts: row.attempts + 1 };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  completeTelegramCommand(id: number): void {
    this.db.prepare("UPDATE telegram_commands SET state='complete',lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(id);
  }

  failTelegramCommand(id: number, error: string, retryDelayMs = 5000, terminal = false): void {
    this.db.prepare(`UPDATE telegram_commands SET state=?,available_at=?,lease_until=NULL,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(terminal ? "failed" : "queued", Date.now() + retryDelayMs, error, id);
  }

  createConversationPlan(input: { chatId: number; messageId: number; mailId: number; requestText: string; scopeMailIds: number[]; plan: Record<string, unknown> }): number {
    this.db.prepare(`INSERT INTO conversation_plans(chat_id,message_id,mail_id,request_text,scope_mail_ids_json,plan_json)
      VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id,message_id) DO NOTHING`)
      .run(input.chatId, input.messageId, input.mailId, input.requestText, JSON.stringify(input.scopeMailIds), JSON.stringify(input.plan));
    const row = this.db.prepare("SELECT id FROM conversation_plans WHERE chat_id=? AND message_id=?")
      .get(input.chatId, input.messageId) as { id: number };
    return row.id;
  }

  getConversationPlan(id: number): StoredConversationPlan | undefined {
    const row = this.db.prepare("SELECT * FROM conversation_plans WHERE id=?").get(id) as any;
    if (!row) return undefined;
    return { id: row.id, chatId: row.chat_id, messageId: row.message_id, mailId: row.mail_id,
      requestText: row.request_text, scopeMailIds: JSON.parse(row.scope_mail_ids_json) as number[],
      plan: JSON.parse(row.plan_json) as Record<string, unknown>, state: row.state };
  }

  finishConversationPlan(id: number, state: StoredConversationPlan["state"], error?: string): void {
    this.db.prepare("UPDATE conversation_plans SET state=?,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(state, error ?? null, id);
  }

  appendConversationToolResult(planId: number, actionIndex: number, kind: string, state: "complete" | "failed" | "skipped" | "waiting_confirmation", result: Record<string, unknown> = {}): void {
    this.db.prepare(`INSERT INTO conversation_tool_results(plan_id,action_index,kind,state,result_json) VALUES(?,?,?,?,?)
      ON CONFLICT(plan_id,action_index) DO NOTHING`).run(planId, actionIndex, kind, state, JSON.stringify(result));
  }

  listConversationToolResults(planId: number): Array<{ actionIndex: number; kind: string; state: string; result: Record<string, unknown> }> {
    return (this.db.prepare("SELECT * FROM conversation_tool_results WHERE plan_id=? ORDER BY action_index").all(planId) as unknown as any[])
      .map((row) => ({ actionIndex: row.action_index, kind: row.kind, state: row.state,
        result: JSON.parse(row.result_json) as Record<string, unknown> }));
  }

  saveMemory(input: Omit<MemoryRecord, "id" | "status" | "supersedesId" | "createdAt" | "updatedAt">): MemoryRecord {
    const accountId = input.scope === "account" ? input.accountId ?? "" : "";
    if (input.scope === "account" && !accountId) throw new Error("Account-scoped memory requires accountId");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(`SELECT id,statement FROM assistant_memories
        WHERE kind=? AND memory_key=? AND scope=? AND account_id=? AND status='active'`)
        .get(input.kind, input.key, input.scope, accountId) as { id: number; statement: string } | undefined;
      if (previous?.statement === input.statement) {
        this.db.exec("COMMIT");
        return this.getMemory(previous.id)!;
      }
      if (previous) this.db.prepare("UPDATE assistant_memories SET status='superseded',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(previous.id);
      const result = this.db.prepare(`INSERT INTO assistant_memories
        (kind,memory_key,statement,scope,account_id,confidence,source,source_mail_id,source_plan_id,supersedes_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(input.kind, input.key, input.statement, input.scope, accountId, input.confidence,
          input.source, input.sourceMailId ?? null, input.sourcePlanId ?? null, previous?.id ?? null);
      this.db.exec("COMMIT");
      return this.getMemory(Number(result.lastInsertRowid))!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getMemory(id: number): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM assistant_memories WHERE id=?").get(id) as any;
    return row ? this.rowToMemory(row) : undefined;
  }

  listMemories(includeInactive = false): MemoryRecord[] {
    return (this.db.prepare(`SELECT * FROM assistant_memories ${includeInactive ? "" : "WHERE status='active'"} ORDER BY id DESC`).all() as unknown as any[])
      .map((row) => this.rowToMemory(row));
  }

  setMemoryEnabled(id: number, enabled: boolean): MemoryRecord | undefined {
    const target = this.getMemory(id);
    if (!target || target.status === "superseded") return target;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (enabled) {
        this.db.prepare(`UPDATE assistant_memories SET status='superseded',updated_at=CURRENT_TIMESTAMP
          WHERE kind=? AND memory_key=? AND scope=? AND account_id=? AND status='active' AND id!=?`)
          .run(target.kind, target.key, target.scope, target.accountId ?? "", id);
      }
      this.db.prepare("UPDATE assistant_memories SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(enabled ? "active" : "disabled", id);
      this.db.exec("COMMIT");
      return this.getMemory(id);
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private rowToMemory(row: any): MemoryRecord {
    return { id: row.id, kind: row.kind, key: row.memory_key, statement: row.statement, scope: row.scope,
      confidence: row.confidence, source: row.source, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
      ...(row.account_id ? { accountId: row.account_id } : {}), ...(row.source_mail_id ? { sourceMailId: row.source_mail_id } : {}),
      ...(row.source_plan_id ? { sourcePlanId: row.source_plan_id } : {}), ...(row.supersedes_id ? { supersedesId: row.supersedes_id } : {}) };
  }

  createMailTask(input: { accountId: string; title: string; state: MailTask["state"]; mailIds: number[]; dueAt?: number; timezone: string; dedupeKey: string }): MailTask {
    this.db.prepare(`INSERT INTO mail_tasks(account_id,title,state,mail_ids_json,due_at,timezone,reminder_state,dedupe_key)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`).run(input.accountId, input.title, input.state,
        JSON.stringify([...new Set(input.mailIds)]), input.dueAt ?? null, input.timezone, input.dueAt ? "pending" : "none", input.dedupeKey);
    const row = this.db.prepare("SELECT * FROM mail_tasks WHERE dedupe_key=?").get(input.dedupeKey) as any;
    return this.rowToMailTask(row);
  }

  listMailTasks(activeOnly = true): MailTask[] {
    return (this.db.prepare(`SELECT * FROM mail_tasks ${activeOnly ? "WHERE state IN ('open','waiting')" : ""} ORDER BY COALESCE(due_at,9223372036854775807),id`).all() as unknown as any[])
      .map((row) => this.rowToMailTask(row));
  }

  getMailTask(id: number): MailTask | undefined {
    const row = this.db.prepare("SELECT * FROM mail_tasks WHERE id=?").get(id) as any;
    return row ? this.rowToMailTask(row) : undefined;
  }

  leaseDueReminder(leaseMs = 120_000): MailTask | undefined {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE mail_tasks SET reminder_state='pending',lease_until=NULL WHERE reminder_state='running' AND lease_until<=?").run(now);
      const row = this.db.prepare(`SELECT * FROM mail_tasks WHERE state IN ('open','waiting') AND reminder_state='pending'
        AND due_at<=? AND available_at<=? ORDER BY due_at,id LIMIT 1`).get(now, now) as any;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      this.db.prepare("UPDATE mail_tasks SET reminder_state='running',attempts=attempts+1,lease_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(now + leaseMs, row.id);
      this.db.exec("COMMIT");
      return this.rowToMailTask({ ...row, reminder_state: "running", attempts: row.attempts + 1 });
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  completeReminder(id: number, telegramMessageId: number): void {
    this.db.prepare("UPDATE mail_tasks SET reminder_state='delivered',telegram_message_id=?,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(telegramMessageId, id);
  }

  failReminder(id: number, error: string, retryDelayMs: number, terminal: boolean): void {
    this.db.prepare("UPDATE mail_tasks SET reminder_state=?,available_at=?,lease_until=NULL,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(terminal ? "failed" : "pending", Date.now() + retryDelayMs, error, id);
  }

  setMailTaskState(id: number, state: MailTask["state"]): MailTask | undefined {
    this.db.prepare(`UPDATE mail_tasks SET state=?,reminder_state=CASE WHEN ? IN ('done','cancelled') AND reminder_state IN ('pending','running')
      THEN 'none' ELSE reminder_state END,lease_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(state, state, id);
    return this.getMailTask(id);
  }

  private rowToMailTask(row: any): MailTask {
    return { id: row.id, accountId: row.account_id, title: row.title, state: row.state,
      mailIds: JSON.parse(row.mail_ids_json) as number[], ...(row.due_at ? { dueAt: row.due_at } : {}),
      timezone: row.timezone, reminderState: row.reminder_state, attempts: row.attempts, dedupeKey: row.dedupe_key,
      ...(row.telegram_message_id ? { telegramMessageId: row.telegram_message_id } : {}) };
  }

  saveAutomationPolicy(input: Omit<AutomationPolicy, "id" | "status">): AutomationPolicy {
    if (input.scope === "account" && !input.accountId) throw new Error("Account-scoped automation requires accountId");
    const result = this.db.prepare(`INSERT INTO automation_policies(name,category,action,scope,account_id,exceptions_json,source)
      VALUES(?,?,?,?,?,?,?)`).run(input.name, input.category, input.action, input.scope,
        input.scope === "account" ? input.accountId ?? "" : "", JSON.stringify(input.exceptions), input.source);
    return this.getAutomationPolicy(Number(result.lastInsertRowid))!;
  }

  getAutomationPolicy(id: number): AutomationPolicy | undefined {
    const row = this.db.prepare("SELECT * FROM automation_policies WHERE id=?").get(id) as any;
    return row ? this.rowToAutomationPolicy(row) : undefined;
  }

  listAutomationPolicies(activeOnly = true): AutomationPolicy[] {
    return (this.db.prepare(`SELECT * FROM automation_policies ${activeOnly ? "WHERE status='active'" : ""} ORDER BY id DESC`).all() as unknown as any[])
      .map((row) => this.rowToAutomationPolicy(row));
  }

  setAutomationPolicyStatus(id: number, status: AutomationPolicy["status"]): AutomationPolicy | undefined {
    this.db.prepare("UPDATE automation_policies SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, id);
    return this.getAutomationPolicy(id);
  }

  saveAutomationDecision(input: Omit<AutomationDecision, "id">, details: Record<string, unknown> = {}): AutomationDecision {
    this.db.prepare(`INSERT INTO automation_decisions(mail_id,policy_id,outcome,reason,details_json) VALUES(?,?,?,?,?)
      ON CONFLICT(mail_id,policy_id) DO UPDATE SET outcome=excluded.outcome,reason=excluded.reason,details_json=excluded.details_json`)
      .run(input.mailId, input.policyId, input.outcome, input.reason, JSON.stringify(details));
    const row = this.db.prepare("SELECT id,mail_id,policy_id,outcome,reason FROM automation_decisions WHERE mail_id=? AND policy_id=?")
      .get(input.mailId, input.policyId) as any;
    return { id: row.id, mailId: row.mail_id, policyId: row.policy_id, outcome: row.outcome, reason: row.reason };
  }

  latestAutomationDecision(mailId: number): AutomationDecision | undefined {
    const row = this.db.prepare("SELECT id,mail_id,policy_id,outcome,reason FROM automation_decisions WHERE mail_id=? ORDER BY id DESC LIMIT 1").get(mailId) as any;
    return row ? { id: row.id, mailId: row.mail_id, policyId: row.policy_id, outcome: row.outcome, reason: row.reason } : undefined;
  }

  setAutomationCategoryStatus(category: AutomationPolicy["category"], scope: AutomationPolicy["scope"], accountId: string | undefined, status: AutomationPolicy["status"]): number {
    return Number(this.db.prepare(`UPDATE automation_policies SET status=?,updated_at=CURRENT_TIMESTAMP
      WHERE category=? AND scope=? AND account_id=?`).run(status, category, scope, scope === "account" ? accountId ?? "" : "").changes);
  }

  mailCreatedAt(id: number): number | undefined {
    const row = this.db.prepare("SELECT created_at FROM mails WHERE id=?").get(id) as { created_at: string } | undefined;
    return row ? Date.parse(`${row.created_at.replace(" ", "T")}Z`) : undefined;
  }

  private rowToAutomationPolicy(row: any): AutomationPolicy {
    return { id: row.id, name: row.name, category: row.category, action: row.action, scope: row.scope,
      exceptions: JSON.parse(row.exceptions_json) as string[], status: row.status, source: row.source,
      ...(row.account_id ? { accountId: row.account_id } : {}) };
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
      accountId: payload.accountId ?? row.account_id,
      accountLabel: payload.accountLabel ?? (row.account_id === this.primaryAccountId ? this.primaryAccountLabel : row.account_id),
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
