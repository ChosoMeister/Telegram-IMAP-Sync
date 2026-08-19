# Configuration reference

Copy `.env.example` to `.env`. Values containing spaces or shell characters do not need quoting in a Compose `env_file`; quoting is allowed and the surrounding quotes are removed. Never commit `.env`.

## Application and storage

| Variable | Required/default | Purpose |
|---|---|---|
| `APP_MODE` | `dry-run` | `live` enables SMTP, Sent APPEND, mail-rule writes, and archive actions. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. Bodies and credentials are redacted. |
| `DATABASE_PATH` | `/data/mailbot.sqlite` | Durable state database. Keep it on the persistent volume. |
| `BACKUP_DIR` | `/data/backups` | Online SQLite backup destination. |
| `BACKUP_INTERVAL_HOURS` | `24` | Backup frequency; minimum 1. |
| `BACKUP_RETENTION` | `7` | Number of newest online backups retained. |
| `DATA_RETENTION_DAYS` | `90` | Deletes only completed local SQLite records after this age; Exchange messages remain untouched. |
| `MAIL_RULES_PATH` | unset | JSON rule file, normally `/app/config/mail-rules.json`. |
| `HONORIFICS_PATH` | unset | Optional JSON map of lowercase email addresses to verified `خانم` or `آقای`; normally `/app/config/honorifics.json`. Unknown people are addressed neutrally. |
| `USER_PROFILE_PATH` | unset | Optional ignored JSON profile, normally `/app/config/user-profile.json`, that identifies the mailbox owner to AI. Copy `config/user-profile.example.json`; include all of the owner's addresses and common name spellings, but never credentials. |
| `MAIL_ACCOUNT_FILES` | required for production | Ordered account files, for example `/app/config/account-orchid.env,/app/config/account-axon.env`. The first file is primary. |
| `HEALTH_PORT` | `8080` | Container health/status HTTP port. Compose exposes it as loopback port 18080. |

## IMAP and SMTP

Every account, including the first, uses the same file copied from `config/mail-account.example.env`. `.env` contains no mailbox credential. Account files are parsed directly rather than sourced by a shell, so special characters in passwords remain literal. Keep them mode `600` and readable by container UID `10001`. Singleton IMAP/SMTP variables in `.env` remain a deprecated compatibility fallback only when `MAIL_ACCOUNT_FILES` is empty.

| Variable | Required/default | Purpose |
|---|---|---|
| `IMAP_HOST` | required per account file | Exchange IMAP hostname reachable from the container. |
| `IMAP_PORT` | `993` | IMAP port. |
| `IMAP_SECURE` | `true` | TLS from connection start. |
| `IMAP_USER`, `IMAP_PASSWORD` | required | IMAP credentials. |
| `IMAP_MAILBOX` | `INBOX` | Watched actionable mailbox. |
| `IMAP_ARCHIVE_MAILBOX` | required for live completion | Existing destination used by Done/Reply/Forward/calendar-RSVP completion. Discover the exact server path first. |
| `IMAP_SENT_MAILBOX` | auto-discovered if unset | Mailbox receiving the exact accepted outbound copy; commonly `Sent Items`. Explicit configuration is safer. |
| `IMAP_RECONCILE_SECONDS` | `300` | Full Inbox reconciliation interval; minimum 30. |
| `TEST_IMPORT_LIMIT` | `0` | Test-only newest-message limit. Production must use `0`. |
| `THREAD_MAX_MESSAGES` | `30` | Maximum messages retrieved from Inbox/Archive/Sent for one thread; range 2–100. |
| `MAX_ATTACHMENT_BYTES` | `25000000` | Maximum single attachment transferred to Telegram or included in Forward. |
| `SMTP_HOST` | required per account file | SMTP submission hostname. |
| `SMTP_PORT` | `587` | Submission port. |
| `SMTP_SECURE` | `false` | `false` normally upgrades with STARTTLS; use `true` for implicit TLS. |
| `SMTP_USER`, `SMTP_PASSWORD` | required | SMTP credentials. |
| `SMTP_FROM` | required | Valid envelope/header sender address. |

## Telegram

| Variable | Required/default | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | required | BotFather token. |
| `TELEGRAM_USER_ID` | required | The only numeric Telegram account authorized to use the bot. |
| `TELEGRAM_REFRESH_HOURS` | `36` | Safe pending-card refresh interval; allowed range 1–47 hours. |
| `TELEGRAM_INITIAL_IMPORT_SILENT` | `false` | Send the initial Inbox import without notifications when `true`. |

## AI

| Variable | Required/default | Purpose |
|---|---|---|
| `AI_ENABLED` | `true` | Disable all analysis/drafting with `false`; mail delivery still works. |
| `AI_PROVIDER_ORDER` | `ollama,proxy` | Ordered fallback chain. Use `proxy,ollama` to prefer the organization proxy. |
| `AI_TIMEOUT_MS` | `45000` | Timeout per provider before failover; minimum 1000 ms. The default accommodates large organizational models and thread-aware Reply generation. |
| `AI_CONTEXT_MAX_CHARS` | `60000` | Maximum serialized email/thread/document characters supplied to AI. |
| `AI_ATTACHMENT_MAX_BYTES` | `10000000` | Stricter maximum file size for in-memory PDF/DOCX/text extraction. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama API base URL as seen from the container. |
| `OLLAMA_MODEL` | `qwen3:14b` | Local model name. |
| `AI_PROXY_BASE_URL` | unset | OpenAI-compatible base URL ending in `/v1`. |
| `AI_PROXY_API_KEY` | unset | Proxy bearer key. |
| `AI_PROXY_MODEL` | `gpt-oss-120b` | Proxy model name. |
| `AI_PROXY_MODEL_ORDER` | value of `AI_PROXY_MODEL` | Ordered models on the same proxy; for example `gpt-oss-120b,gemma4-26b`. |

Unknown providers in `AI_PROVIDER_ORDER` are ignored. A `proxy` entry expands to every model in `AI_PROXY_MODEL_ORDER`; timeout, HTTP failure, invalid JSON, or schema failure advances to the next model. If all models/providers fail, Telegram receives the usable email card without AI enrichment.

Ask AI supports the current email, its real extractable attachments, or its thread. Extractable formats are PDF, DOCX, HTML, TXT, CSV, TSV, JSON, XML, and log/text MIME types. Unsupported and oversized files are named in the context with a reason rather than parsed. Files are processed in memory and are not persisted by the extractor.

The Persian administrative wording policy is intentionally not configurable per provider: every configured model receives the same instruction and every generated result is normalized before use. Reply drafts never infer gender. Copy `config/honorifics.example.json` to the ignored `config/honorifics.json` only for people whose title is known and verified. Manual edits entered in Telegram bypass this normalization and remain verbatim.

Copy `config/user-profile.example.json` to the ignored `config/user-profile.json` and set `USER_PROFILE_PATH` to enable owner awareness. `displayNameFa`, optional English name, aliases, and every owned email address are trusted identity context. Organization and job title are optional. The analyzer classifies the action owner as self, other, shared, or unknown; self actions are rendered as `اقدام شما` and use direct second-person wording. A deterministic post-processor also replaces profile-name references in suggested actions if a model ignores the instruction. The profile is not an authentication source and must never contain a password or token.

Calendar detection, event fields, RSVP validity, and urgency scores do not depend on AI configuration. A calendar RSVP requires `SMTP_FROM` to match an Attendee address and uses the same SMTP, Sent, and Archive settings as a normal reply.

## Production minimum

Set real values for IMAP, SMTP, Telegram, archive, and sent-mail settings; set `TEST_IMPORT_LIMIT=0`. Run `npm run discover` and `npm run preflight` in the built container before switching `APP_MODE=live`. Keep `.env`, `config/account-*.env`, `config/mail-rules.json`, `config/honorifics.json`, `config/user-profile.json`, and backup files outside Git.
