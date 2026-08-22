import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const schema = z.object({
  APP_MODE: z.enum(["live", "dry-run"]).default("dry-run"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_PATH: z.string().default("/data/mailbot.sqlite"),
  BACKUP_DIR: z.string().default("/data/backups"),
  BACKUP_INTERVAL_HOURS: z.coerce.number().int().min(1).default(24),
  BACKUP_RETENTION: z.coerce.number().int().min(1).default(7),
  DATA_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  MAIL_RULES_PATH: z.string().optional(),
  HONORIFICS_PATH: z.string().optional(),
  USER_PROFILE_PATH: z.string().optional(),
  MAIL_ACCOUNT_FILES: z.string().optional(),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  IMAP_HOST: z.string().min(1).optional(),
  IMAP_PORT: z.coerce.number().int().default(993),
  IMAP_SECURE: bool.default(true),
  IMAP_USER: z.string().min(1).optional(),
  IMAP_PASSWORD: z.string().min(1).optional(),
  IMAP_MAILBOX: z.string().default("INBOX"),
  IMAP_ARCHIVE_MAILBOX: z.string().optional(),
  IMAP_SENT_MAILBOX: z.string().optional(),
  IMAP_RECONCILE_SECONDS: z.coerce.number().int().min(30).default(300),
  TEST_IMPORT_LIMIT: z.coerce.number().int().min(0).default(0),
  THREAD_MAX_MESSAGES: z.coerce.number().int().min(2).max(100).default(30),
  MAX_ATTACHMENT_BYTES: z.coerce.number().int().min(1_000_000).default(25_000_000),

  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  SMTP_FROM: z.string().email().optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(10),
  TELEGRAM_USER_ID: z.coerce.number().int(),
  TELEGRAM_REFRESH_HOURS: z.coerce.number().min(1).max(47).default(36),
  TELEGRAM_INITIAL_IMPORT_SILENT: bool.default(false),

  VOICE_REPLY_ENABLED: bool.default(false),
  VOICE_MAX_SECONDS: z.coerce.number().int().min(1).max(600).default(180),
  VOICE_MAX_BYTES: z.coerce.number().int().min(1_000).max(20_000_000).default(10_000_000),
  VOICE_KEEP_AUDIO: bool.default(false),
  STT_BASE_URL: z.string().url().optional(),
  STT_API_KEY: z.string().optional(),
  STT_MODEL_ORDER: z.string().default("local-qwen3-asr-1.7b,local-whisper-large-v3"),
  STT_LANGUAGE: z.string().min(2).max(16).default("auto"),
  STT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(90_000),

  AI_PROVIDER_ORDER: z.string().default("ollama,proxy"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).default(45000),
  AI_CONTEXT_MAX_CHARS: z.coerce.number().int().min(4_000).default(60_000),
  AI_ATTACHMENT_MAX_BYTES: z.coerce.number().int().min(100_000).default(10_000_000),
  OLLAMA_BASE_URL: z.string().url().default("http://host.docker.internal:11434"),
  OLLAMA_MODEL: z.string().default("qwen3:14b"),
  AI_PROXY_BASE_URL: z.string().url().optional(),
  AI_PROXY_API_KEY: z.string().optional(),
  AI_PROXY_MODEL: z.string().default("gpt-oss-120b"),
  AI_PROXY_MODEL_ORDER: z.string().optional(),
  AI_TRANSCRIPT_MODEL_ORDER: z.string().optional(),
  AI_ENABLED: bool.default(true)
});

export type AppConfig = z.infer<typeof schema> & { aiProviderOrder: string[]; aiProxyModelOrder: string[]; aiTranscriptModelOrder: string[]; sttModelOrder: string[] };
type RequiredMailKey = "IMAP_HOST" | "IMAP_USER" | "IMAP_PASSWORD" | "SMTP_HOST" | "SMTP_USER" | "SMTP_PASSWORD" | "SMTP_FROM";
export type MailAccountAppConfig = Omit<AppConfig, RequiredMailKey> & { [K in RequiredMailKey]-?: Exclude<AppConfig[K], undefined> } & { mailAccountId: string; mailAccountLabel: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  if (parsed.VOICE_REPLY_ENABLED && (!parsed.STT_BASE_URL || !parsed.STT_API_KEY)) {
    throw new Error("VOICE_REPLY_ENABLED=true requires STT_BASE_URL and STT_API_KEY");
  }
  if (parsed.VOICE_KEEP_AUDIO) throw new Error("VOICE_KEEP_AUDIO=true is not supported; voice audio must remain ephemeral");
  return {
    ...parsed,
    aiProviderOrder: parsed.AI_PROVIDER_ORDER.split(",").map((v) => v.trim()).filter(Boolean),
    aiProxyModelOrder: (parsed.AI_PROXY_MODEL_ORDER || parsed.AI_PROXY_MODEL).split(",").map((v) => v.trim()).filter(Boolean),
    aiTranscriptModelOrder: (parsed.AI_TRANSCRIPT_MODEL_ORDER || parsed.AI_PROXY_MODEL_ORDER || parsed.AI_PROXY_MODEL).split(",").map((v) => v.trim()).filter(Boolean),
    sttModelOrder: parsed.STT_MODEL_ORDER.split(",").map((v) => v.trim()).filter(Boolean)
  };
}
