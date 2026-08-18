# Telegram IMAP Sync

A self-hosted, single-user action inbox that mirrors an Exchange Inbox to Telegram. It supports local/organizational AI analysis, full-text retrieval, on-demand attachments, safe Done/archive, and AI-assisted Reply/Reply All.

The project is currently safe to configure and test, but defaults to `APP_MODE=dry-run`. Do not enable live actions until the Exchange folder discovery checklist has been completed.

## What is implemented

- Full Inbox import plus continuous reconciliation
- Stable IMAP deduplication using mailbox, UIDVALIDITY, and UID
- Immediate Telegram delivery followed by background AI enrichment
- Configurable AI order: Ollama and OpenAI-compatible organizational proxy
- Persian priority, summary, suggested action, and deadline extraction
- HTML-to-text handling with same-card pagination and Back navigation
- On-demand real attachments with inline signature-image filtering
- Done: verified Exchange archive, then Telegram cleanup
- Pending queue rotation every 36 hours, oldest-to-newest and silent
- AI-assisted Reply and Reply All with tone, custom instruction, direct editing, and explicit approval
- AI-assisted Forward to one or more recipients with a custom note and original attachments
- Exact sent-copy storage in Exchange Sent after SMTP acceptance
- Retry-safe SMTP, Sent-copy, and Archive transaction stages
- SQLite recovery state, health endpoint, structured redacted logs
- Multi-architecture Docker design for Linux, macOS, and Windows hosts

See [product specification](docs/SPEC.md) and [architecture](docs/ARCHITECTURE.md).

## Local preparation

```sh
cp .env.example .env
```

Fill `.env` locally. Never commit real passwords, bot tokens, or AI keys.

For Docker Desktop, `host.docker.internal` reaches Ollama on the host. Compose also supplies the compatible host mapping on Linux.

## Validation

```sh
npm install
npm run check
docker compose config
docker compose build
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

## Safe commissioning sequence

1. Keep `APP_MODE=dry-run`.
2. Validate IMAP/SMTP TLS and credentials without printing them.
3. Discover live Exchange mailbox paths and choose the exact archive destination.
4. Start the service and verify read-only import with a single test email.
5. Confirm Telegram user authorization, HTML extraction, AI fallback, and attachment filtering.
6. Test SMTP reply to a controlled recipient and confirm the matching copy in `Sent` and Outlook threading.
7. Test archive with one non-critical message and verify it in Outlook.
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
npm run check
```

## Security notes

- Telegram and email actions are restricted to one numeric user ID.
- `APP_MODE=dry-run` blocks SMTP and IMAP archive writes.
- Email bodies and credentials are not logged.
- Attachments are held in memory only for on-demand transfer.
- The `.env` file stays untracked.
- The container uses a read-only root filesystem, drops all capabilities, and uses `no-new-privileges`.
