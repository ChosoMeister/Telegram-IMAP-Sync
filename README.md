# Telegram IMAP Sync

A self-hosted, single-user action inbox that mirrors independent IMAP mailboxes—including Exchange, Gmail, and Google Workspace—to Telegram. It supports local/organizational AI analysis, full-text retrieval, on-demand attachments, safe Done/archive, AI-assisted Reply/Reply All, and transactional Exchange calendar RSVP.

The project is currently safe to configure and test, but defaults to `APP_MODE=dry-run`. Do not enable live actions until the mailbox discovery checklist has been completed for every account.

## What is implemented

- Full Inbox import plus lightweight UID reconciliation; MIME and attachments are fetched only for new messages
- Stable IMAP deduplication using mailbox, UIDVALIDITY, and UID
- One Telegram card per exact RFC email thread; later Inbox replies replace the card at the bottom and show a chronological sectioned timeline
- Immediate Telegram delivery followed by background AI enrichment
- Configurable AI order: Ollama and OpenAI-compatible organizational proxy
- Persian priority, summary, suggested action, and deadline extraction
- Deterministic `text/calendar` detection with structured Persian event cards for invitations, updates, and cancellations, independent of attachment filename
- Exchange-compatible Accept/Tentative/Decline responses with durable SMTP, Sent-copy, Archive, and Telegram cleanup stages plus deterministic deadline-based calendar priority
- Calendar-specific mobile UI: RSVP plus Done/Ask AI only, with same-card final confirmation before sending
- Enforced Persian administrative style: `با درود و مهر` / `با سپاس`, with deterministic post-processing if a model ignores the policy
- HTML-to-text handling with same-card pagination for the latest message or every merged Inbox message, plus Back navigation
- On-demand real attachments with inline signature-image filtering
- Multi-signal separation of real attachments from CID images, logos, icons, and signature assets, with an on-demand hidden-file review
- Done: verified Exchange archive, then Telegram cleanup
- Pending queue rotation every 36 hours, oldest-to-newest and silent
- AI-assisted Reply and Reply All with tone, typed or Telegram Voice instruction, direct editing, and explicit approval
- In-memory parallel Qwen/Whisper speech-to-text with automatic Persian-English code switching, conservative AI consensus, confidence/uncertainty review, exact ForceReply mail binding, and no retained audio
- Exact ForceReply-to-mail binding, preventing text meant for one open draft/question from being applied to another
- AI-assisted Forward to one or more recipients with a custom note and original attachments
- Free-form Ask AI over the current message, extractable PDF/DOCX/text attachments, or the full mail thread
- Thread discovery across Inbox, Archive, and Sent with AI status summary and thread-aware reply drafts
- Gender-neutral AI addressing by default, with optional verified per-address Persian honorifics
- Optional local owner profile so AI recognizes the user across their names and email addresses and renders self-assigned work as a direct `Your action`
- Multi-server All Inbox through one Telegram bot, with every reply, forward, RSVP, Sent copy, and Archive action routed through the receiving account
- Gmail and Google Workspace accounts through IMAP/SMTP with an App Password and account-scoped Reply, Sent, and Archive routing
- Ordered fallback across multiple models on the same organizational AI proxy
- Independent transcript-judge model preference for fast mixed-language Voice consensus without changing normal email analysis quality
- Optional local mail-rule engine for Exchange folder routing before Telegram delivery
- Exact sent-copy storage in Exchange Sent after SMTP acceptance
- Retry-safe SMTP, Sent-copy, and Archive transaction stages
- Atomic per-mail action locks with duplicate-click cooldown, same-card progress, versioned SQLite migrations, and a durable AI analysis queue
- Stable pre-send Message-ID and durable outbound RFC822 recovery state
- Automatic IMAP reconnect with exponential backoff and disconnect-aware reconciliation
- Telegram rate-limit/transient-failure backoff without unsafe message-send retries
- SQLite recovery state, IMAP-aware health endpoint, structured redacted logs
- Online SQLite backups with configurable retention
- Component health for AI, SMTP, Telegram, backup, queue, and IMAP plus completed-state retention
- Multi-architecture Docker design for Linux, macOS, and Windows hosts

## Documentation

- [Configuration reference](docs/CONFIGURATION.md) — every environment variable and production guidance
- [Operations runbook](docs/OPERATIONS.md) — deploy, upgrade, backup, restore, health, and troubleshooting
- [Mail rules](docs/MAIL_RULES.md) — optional local routing before Telegram delivery
- [Product specification](docs/SPEC.md) and [architecture](docs/ARCHITECTURE.md)
- [Multi-account / All Inbox design](docs/MULTI_ACCOUNT_DESIGN.md) — account-scoped IMAP/SMTP architecture and rollout
- [Gmail / Google Workspace setup](docs/GMAIL.md) — App Password, folders, SMTP modes, discovery, and commissioning
- [Release and documentation checklist](docs/MAINTENANCE.md)
- [راهنمای فارسی](README.fa.md)

## Local preparation

```sh
cp .env.example .env
cp config/mail-account.example.env config/account-orchid.env
```

Fill global settings in `.env` and IMAP/SMTP settings in one ignored `config/account-<id>.env` per account. List the files in `MAIL_ACCOUNT_FILES`. Never commit credentials.

For Docker Desktop, `host.docker.internal` reaches Ollama on the host. Compose also supplies the compatible host mapping on Linux.

## Validation

```sh
npm install
npm run check
docker compose config
docker compose build
```

Published Linux `amd64`/`arm64` images are available from GitHub Container Registry:

```sh
docker pull ghcr.io/chosomeister/telegram-imap-sync:latest
docker pull ghcr.io/chosomeister/telegram-imap-sync:0.11.1
```

## Windows installation (Docker Desktop)

Install Git and Docker Desktop, enable the WSL 2 backend, then run these commands in PowerShell from the cloned repository:

```powershell
Copy-Item .env.example .env
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
```

Edit `.env` before `docker compose up -d`. PowerShell does not need Node.js or npm when the application is built entirely with Docker. Keep the repository on a local NTFS path and use Docker Desktop with Linux containers.

If Ollama runs on Windows, keep `OLLAMA_BASE_URL=http://host.docker.internal:11434` and make sure Ollama accepts connections from Docker Desktop. The named Docker volume preserves SQLite data across container rebuilds.

Useful Windows operations:

```powershell
docker compose logs -f --tail 100
docker compose restart
docker compose down
```

`docker compose down` keeps the mailbox database. Do not add `--volumes` unless you intentionally want to erase local bot state.

The health endpoint is exposed only on the local machine:

```text
http://127.0.0.1:18080/
```

It returns HTTP `200` only while the IMAP connection is usable. During an Exchange disconnect it returns `503`; the service reconnects automatically with a capped exponential backoff and reconciles Inbox immediately after recovery.
The JSON response also reports the last successful reconciliation, last Telegram poll, Inbox count, and state counts. Online backups are written under `/data/backups`; copy them to independent storage as part of host backup policy.

## Safe commissioning sequence

1. Keep `APP_MODE=dry-run`.
2. Validate IMAP/SMTP TLS and credentials without printing them.
3. Discover live mailbox paths and choose the exact archive and Sent destinations for every account.
   Exchange commonly uses `Sent Items`; Gmail commonly exposes `[Gmail]/All Mail` and `[Gmail]/Sent Mail`, but discovery is authoritative.
4. Start the service and verify read-only import with a single test email.
5. Confirm Telegram user authorization, HTML extraction, AI fallback, and attachment filtering.
6. Test SMTP reply to a controlled recipient and confirm the matching copy in the configured Sent mailbox and provider threading.
7. Test archive with one non-critical message and verify it in the provider's mail client.
8. Back up the SQLite volume, then set `APP_MODE=live`.

For a bounded dry-run, set `TEST_IMPORT_LIMIT=1`, `2`, or `3`. Set it back to `0` before production deployment; a nonzero value intentionally watches only the newest messages.

## Commands

```sh
npm run dev
npm run build
npm run discover
npm run preflight
npm test
npm run lint
npm run docs:check
npm run check
```

## Security notes

- Telegram and email actions are restricted to one numeric user ID.
- `APP_MODE=dry-run` blocks SMTP and IMAP archive writes.
- Email bodies and credentials are not logged.
- Attachments are held in memory only for on-demand transfer.
- The `.env` file stays untracked.
- The container uses a read-only root filesystem, drops all capabilities, and uses `no-new-privileges`.
- GHCR images include OCI revision labels and GitHub build-provenance attestations; they are not currently Cosign-signed.
