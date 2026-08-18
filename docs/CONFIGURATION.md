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
| `MAIL_RULES_PATH` | unset | JSON rule file, normally `/app/config/mail-rules.json`. |
| `HEALTH_PORT` | `8080` | Container health/status HTTP port. Compose exposes it as loopback port 18080. |

## IMAP and SMTP

| Variable | Required/default | Purpose |
|---|---|---|
| `IMAP_HOST` | required | Exchange IMAP hostname reachable from the container. |
| `IMAP_PORT` | `993` | IMAP port. |
| `IMAP_SECURE` | `true` | TLS from connection start. |
| `IMAP_USER`, `IMAP_PASSWORD` | required | IMAP credentials. |
| `IMAP_MAILBOX` | `INBOX` | Watched actionable mailbox. |
| `IMAP_ARCHIVE_MAILBOX` | required for live completion | Existing destination used by Done/Reply/Forward completion. Discover the exact server path first. |
| `IMAP_SENT_MAILBOX` | auto-discovered if unset | Mailbox receiving the exact accepted outbound copy; commonly `Sent Items`. Explicit configuration is safer. |
| `IMAP_RECONCILE_SECONDS` | `300` | Full Inbox reconciliation interval; minimum 30. |
| `TEST_IMPORT_LIMIT` | `0` | Test-only newest-message limit. Production must use `0`. |
| `SMTP_HOST` | required | SMTP submission hostname. |
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
| `AI_TIMEOUT_MS` | `30000` | Timeout per provider; minimum 1000 ms. |
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | Ollama API base URL as seen from the container. |
| `OLLAMA_MODEL` | `qwen3:14b` | Local model name. |
| `AI_PROXY_BASE_URL` | unset | OpenAI-compatible base URL ending in `/v1`. |
| `AI_PROXY_API_KEY` | unset | Proxy bearer key. |
| `AI_PROXY_MODEL` | `gpt-oss-120b` | Proxy model name. |

Unknown providers in `AI_PROVIDER_ORDER` fail that attempt and allow the next provider. If all providers fail, Telegram receives the usable email card without AI enrichment.

## Production minimum

Set real values for IMAP, SMTP, Telegram, archive, and sent-mail settings; set `TEST_IMPORT_LIMIT=0`. Run `npm run discover` and `npm run preflight` in the built container before switching `APP_MODE=live`. Keep `.env`, `config/mail-rules.json`, and backup files outside Git.
