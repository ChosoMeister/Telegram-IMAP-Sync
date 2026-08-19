import type { AppConfig } from "../src/config.js";
import type { IncomingMail } from "../src/domain/types.js";

export const config: AppConfig = {
  APP_MODE: "dry-run", LOG_LEVEL: "error", DATABASE_PATH: ":memory:", BACKUP_DIR: "/tmp/backups", BACKUP_INTERVAL_HOURS: 24, BACKUP_RETENTION: 7, DATA_RETENTION_DAYS: 90, HEALTH_PORT: 8080,
  PRIMARY_ACCOUNT_ID: "primary", PRIMARY_ACCOUNT_LABEL: "Primary",
  IMAP_HOST: "imap.example", IMAP_PORT: 993, IMAP_SECURE: true, IMAP_USER: "user", IMAP_PASSWORD: "pass",
  IMAP_MAILBOX: "INBOX", IMAP_ARCHIVE_MAILBOX: "Archive", IMAP_RECONCILE_SECONDS: 300,
  TEST_IMPORT_LIMIT: 0, THREAD_MAX_MESSAGES: 30, MAX_ATTACHMENT_BYTES: 25_000_000,
  SMTP_HOST: "smtp.example", SMTP_PORT: 587, SMTP_SECURE: false, SMTP_USER: "user", SMTP_PASSWORD: "pass", SMTP_FROM: "me@example.com",
  TELEGRAM_BOT_TOKEN: "1234567890:test", TELEGRAM_USER_ID: 42, TELEGRAM_REFRESH_HOURS: 36, TELEGRAM_INITIAL_IMPORT_SILENT: false,
  AI_PROVIDER_ORDER: "ollama,proxy", AI_TIMEOUT_MS: 1000, AI_CONTEXT_MAX_CHARS: 60_000, AI_ATTACHMENT_MAX_BYTES: 10_000_000, OLLAMA_BASE_URL: "http://localhost:11434", OLLAMA_MODEL: "test",
  AI_PROXY_MODEL: "test", AI_ENABLED: true,
  aiProviderOrder: ["ollama", "proxy"], aiProxyModelOrder: ["test"]
};

export const incoming: IncomingMail = {
  uid: 7, uidValidity: "999", mailbox: "INBOX", messageId: "<mail@example.com>", references: [],
  subject: "Test", from: [{ name: "Sender", address: "sender@example.com" }],
  to: [{ address: "me@example.com" }], cc: [{ address: "team@example.com" }], replyTo: [],
  receivedAt: new Date("2026-08-18T10:00:00Z"), text: "Hello", attachments: []
};
