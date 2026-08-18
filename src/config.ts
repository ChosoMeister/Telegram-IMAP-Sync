import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  APP_MODE: z.enum(["live", "dry-run"]).default("dry-run"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_PATH: z.string().default("/data/mailbot.sqlite"),
  BACKUP_DIR: z.string().default("/data/backups"),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
  BACKUP_RETENTION: z.coerce.number().int().min(1).default(7),
  MAIL_RULES_PATH: z.string().optional(),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  IMAP_HOST: z.string().min(1),
  IMAP_PORT: z.coerce.number().int().default(993),
  IMAP_SECURE: bool.default(true),
  IMAP_USER: z.string().min(1),
  IMAP_PASSWORD: z.string().min(1),
  IMAP_MAILBOX: z.string().default("INBOX"),
  IMAP_ARCHIVE_MAILBOX: z.string().optional(),
  IMAP_SENT_MAILBOX: z.string().optional(),
  IMAP_RECONCILE_SECONDS: z.coerce.number().int().min(30).default(300),
  TEST_IMPORT_LIMIT: z.coerce.number().int().min(0).default(0),

  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_FROM: z.string().email(),

  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_USER_ID: z.coerce.number().int(),
  TELEGRAM_REFRESH_HOURS: z.coerce.number().min(1).max(47).default(36),
  TELEGRAM_INITIAL_IMPORT_SILENT: bool.default(false),

  AI_PROVIDER_ORDER: z.string().default("ollama,proxy"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  OLLAMA_BASE_URL: z.string().url().default("http://host.docker.internal:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:14b"),
  AI_PROXY_BASE_URL: z.string().url().optional(),
  AI_PROXY_API_KEY: z.string().optional(),
  AI_PROXY_MODEL: z.string().default("gpt-oss-120b"),
  AI_ENABLED: bool.default(true)
});

export type AppConfig = z.infer<typeof schema> & { aiProviderOrder: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    aiProviderOrder: parsed.AI_PROVIDER_ORDER.split(",").map((v) => v.trim()).filter(Boolean)
  };
}
