# Operations runbook

## Deploy from source

The same Compose file works with Docker Desktop on Windows/macOS and Docker Engine with Compose v2 on Linux:

```sh
git clone https://github.com/ChosoMeister/Telegram-IMAP-Sync.git
cd Telegram-IMAP-Sync
cp .env.example .env
# edit .env
docker compose config --quiet
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail 100
```

In PowerShell, use `Copy-Item .env.example .env`. Keep Docker Desktop in Linux-container mode. `host.docker.internal` is provided for host Ollama on all supported hosts.

GHCR publishes `latest`, the package version, and immutable `sha-<commit>` tags for Linux `amd64` and `arm64`. Pulling is useful for inspection or custom deployment; the repository Compose file intentionally builds the checked-out source so code and configuration stay auditable.

Version 0.3.0 automatically creates versioned SQLite migrations on first start. Existing Inbox messages that contain pre-0.3 attachment metadata are refetched once, reclassified, and edited in place; this does not generate replacement cards.

## Commission safely

1. Start with `APP_MODE=dry-run` and a bounded `TEST_IMPORT_LIMIT=1`.
2. Build, then run `docker compose run --rm mailbot npm run discover` to list exact Exchange mailbox paths.
3. Set `IMAP_ARCHIVE_MAILBOX` and `IMAP_SENT_MAILBOX` to verified existing paths.
4. Run `docker compose run --rm mailbot npm run preflight`.
5. Verify one imported card, full-text pagination, attachments, and AI fallback.
6. In live mode, send one controlled Reply and verify SMTP delivery, Outlook threading, the exact copy in the configured sent mailbox, source archiving, and Telegram cleanup.
7. Set `TEST_IMPORT_LIMIT=0` for production.

## Health and status

`http://127.0.0.1:18080/` returns `200` only while IMAP is usable and `503` while disconnected. JSON includes connection state, last successful reconciliation, last Telegram poll, Inbox/state counts, durable job counts, AI provider results, SMTP and Telegram activity, backup success/error, mode, and current time. Inside Telegram, `/status` reports the operational subset.

Useful commands:

```sh
docker compose ps
docker compose logs -f --tail 200
curl --fail-with-body http://127.0.0.1:18080/
docker compose restart mailbot
```

## Backup and restore

The application creates a WAL-safe online backup under `/data/backups` every `BACKUP_INTERVAL_HOURS`; the newest `BACKUP_RETENTION` files remain. Copy backups to independent host storage:

```sh
docker compose exec mailbot sh -lc 'ls -lah /data/backups'
docker compose cp mailbot:/data/backups ./mailbot-backups
```

Restore only while the service is stopped. Preserve the current volume first, then copy one verified backup over the configured database path. Do not copy a live `mailbot.sqlite` file directly because WAL state may be missing.

```sh
docker compose stop mailbot
docker compose run --rm --no-deps --entrypoint sh mailbot -lc 'cp /data/backups/CHOSEN_BACKUP.sqlite /data/mailbot.sqlite'
docker compose up -d
curl --fail-with-body http://127.0.0.1:18080/
```

Replace `CHOSEN_BACKUP.sqlite` with an actual listed filename. If `DATABASE_PATH` differs, restore to that exact path.

## Upgrade and rollback

```sh
git fetch --all --tags
git pull --ff-only
npm ci
npm run check
docker compose build --pull
docker compose up -d
docker compose logs --tail 100
```

For rollback, check out a known commit/tag, rebuild, and start without deleting the named volume. Never use `docker compose down --volumes` during a normal upgrade or rollback.

## Troubleshooting

- **IMAP `ECONNREFUSED`:** test DNS and TCP reachability from inside the container. An internal hostname must resolve to the internal address there; Docker cannot bypass firewall/routing policy.
- **Telegram `ECONNREFUSED`:** the host/network is blocking `api.telegram.org:443`. Fix routing, proxy, or firewall; repeated container restarts will not solve it.
- **AI proxy returns 404 at `/v1`:** a base endpoint may legitimately return 404. Test `/v1/chat/completions`; AI failure is non-blocking and falls through according to `AI_PROVIDER_ORDER`.
- **Ollama unavailable:** confirm the host listener accepts Docker traffic and use `host.docker.internal`, not container loopback.
- **Reply delivered but no sent copy:** verify `IMAP_SENT_MAILBOX` and APPEND permission. The transaction remains at the Sent-copy stage and does not blindly repeat accepted SMTP.
- **Ambiguous SMTP attempt:** inspect the configured sent mailbox for the persisted Message-ID before any manual retry. Duplicate prevention intentionally wins over automatic resend.
- **Telegram and Inbox counts differ:** wait for two reconciliation cycles. External moves are confirmed twice before card cleanup. Ensure `TEST_IMPORT_LIMIT=0`.
- **Old Telegram card cannot be deleted:** Telegram limits deletion of old messages. Rotation reduces this risk, but prolonged bot downtime can exceed that window.
- **Signature images still appear as attachments:** inspect `classificationReason` through the hidden-image review, retain a sanitized MIME sample, and add a regression fixture. Do not globally hide all small images because screenshots may be legitimate attachments.
- **A real image was hidden:** use `Review hidden images`; the file remains retrievable and is not forwarded by default. Classification changes require refetching that Inbox message or receiving a new copy.
- **Thread has unrelated messages:** repeated generic subjects can produce false candidates. Message-ID relationships are preferred; lower `THREAD_MAX_MESSAGES` and retain exact `References` headers when collecting a sanitized fixture.
- **Ask AI reports unsupported attachment:** current extraction supports PDF, DOCX, HTML, and text/CSV-like formats. Images require OCR and legacy DOC/XLS or XLSX require a future isolated converter.
- **AI feels stuck:** the primary Telegram card changes immediately to a progress state. Each provider is limited by `AI_TIMEOUT_MS` (15 seconds by default) before fallback; structured logs include the nested network code and cause.
- **Brief IMAP warning followed by restored:** Exchange or the network closed the long-lived session. Reconciliation waits for the reconnect supervisor and retries automatically; investigate only when health remains `503` or reconnect does not follow.
- **AI job is failed:** health reports job counts and provider status. A background analysis becomes terminal after five provider failures; the email remains fully usable and interactive Ask AI can be retried later.
- **AI returns the old greeting/closing:** version 0.3.1 normalizes generated output after the provider response. Confirm the running image/version and rebuild/redeploy; manually edited text is intentionally preserved verbatim.
- **Restart loop:** inspect the first fatal log entry, validate `.env` with `docker compose config`, and test required destinations from inside the container.
