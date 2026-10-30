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

Version 0.9.0 moves every account, including the primary, to an ignored account file. Keep the first `MAIL_ACCOUNT_FILES` entry stable (`account-orchid.env` on the current deployment); this preserves existing rows, Telegram IDs, thread keys, and pending state. Back up `.env`, every account file, and SQLite before changing order. Version 0.8.0 added account-scoped storage; earlier migrations remain automatic.

For a new additional account, validate its folders and SMTP in a one-off dry-run before adding its file to `MAIL_ACCOUNT_FILES`. After activation, confirm the health JSON contains a connected entry for every account. A disconnected account makes aggregate readiness `503` but does not stop reconciliation and actions for connected accounts. Never run multiple containers with the same Telegram bot token.

## Commission safely

1. Start with `APP_MODE=dry-run` and a bounded `TEST_IMPORT_LIMIT=1`.
2. Build, then run `docker compose run --rm mailbot npm run discover` to list exact Exchange mailbox paths.
3. Set `IMAP_ARCHIVE_MAILBOX` and `IMAP_SENT_MAILBOX` to verified existing paths.
4. Run `docker compose run --rm mailbot npm run preflight`.
5. Verify one imported card, full-text pagination, attachments, and AI fallback.
   When Voice is enabled, record one controlled mixed Persian-English instruction, inspect both raw ASR outputs, verify consensus confidence/uncertainty, correct or approve the transcript, and only then verify draft generation. Force one ASR to fail in a test environment and confirm the healthy peer remains usable without retaining audio.
6. In live mode, send one controlled Reply and verify SMTP delivery, Outlook threading, the exact copy in the configured sent mailbox, source archiving, and Telegram cleanup.
7. Set `TEST_IMPORT_LIMIT=0` for production.

## Health and status

`http://127.0.0.1:18080/` returns `200` only while IMAP is usable and `503` while disconnected. JSON includes each account's transport state and notification mode (`idle`, `idle-pending`, `polling-fallback`, or `unavailable`), last successful reconciliation, last Telegram poll, Inbox/state counts, durable job counts, learned-rule totals, AI provider results, SMTP and Telegram activity, backup success/error, mode, and current time. Inside Telegram, `/status` and `/accounts` report the operational subset. `idle-pending` is the normal short connected period before ImapFlow automatically enters IDLE; `polling-fallback` means the server did not advertise IDLE.

`/memory` lists confirmed and inferred assistant memories with their account/global scope and allows active non-superseded entries to be disabled or restored. Confirmed memories originate from explicit user wording; inferred model observations are stored for review but do not affect analysis until confirmed. A newer correction with the same kind/key/scope supersedes the old value.

`/tasks` lists open and waiting mail tasks. A conversational request can create a task with or without a reminder; reminder time is rendered in `USER_TIMEZONE`. The task remains open after delivery and after its source email is archived or replied to. Telegram delivery has its own leased state and bounded retry; only a successful Bot API response marks it delivered. Use the task buttons to mark it done or cancel it.

`/automations` lists explicit user-created automation policies and allows each one to be paused or resumed. Start with `AUTOMATION_MODE=observe`, recreate the container, and inspect recorded reasons before considering execution. Observation never moves mail. `execute` is a separate mode with its own activation watermark, so messages that predate execution—including mail seen during observation—are not retroactively archived. If `APP_MODE` is not `live`, configured execution automatically degrades to observation. Even in effective execute mode, exceptions and high/critical messages remain pending. Policy creation or disabling requires an explicit conversational request such as «خبرنامه‌ها را خودکار آرشیو کن؛ انقضا استثناست»; AI inference alone cannot grant permission.

Safe activation sequence:

1. Keep `APP_MODE=live` only after normal archive commissioning is complete; set `AUTOMATION_MODE=observe` and recreate the container.
2. Create one narrow account-scoped policy, then review `/automations`, health status, and decision explanations on new controlled mail.
3. Back up SQLite. If observation is correct, set `AUTOMATION_MODE=execute` and recreate the container. Do not edit the SQLite activation watermark.
4. Send a new controlled matching email and verify Exchange Archive, Telegram cleanup, and the stored explanation. Pause the policy immediately from `/automations` if classification is not conservative.

Useful commands:

```sh
docker compose ps
docker compose logs -f --tail 200
curl --fail-with-body http://127.0.0.1:18080/
docker compose restart mailbot
```

## Backup and restore

The application creates a WAL-safe online backup under `/data/backups` after the last successful backup becomes `BACKUP_INTERVAL_HOURS` old; the newest `BACKUP_RETENTION` files remain. Startup and an hourly due check do not create extra files while a recent successful backup exists. A failed due backup is retried by the next hourly check. Copy backups to independent host storage:

```sh
docker compose exec mailbot sh -lc 'ls -lah /data/backups'
docker compose cp mailbot:/data/backups ./mailbot-backups
```

Restore only while the service is stopped. Preserve the current volume first, then copy one verified backup over the configured database path. Do not copy a live `mailbot.sqlite` file directly because WAL state may be missing.

### Optional Telegram backup destination

Use a dedicated private group or channel rather than the operational mailbox chat. Add the bot with permission to post files. In a private group, send `/chatid` as the authorized Telegram user, copy the negative ID, and set it as `BACKUP_TELEGRAM_CHAT_ID`. For a forum topic, set `BACKUP_TELEGRAM_MESSAGE_THREAD_ID` to the final topic number in its URL (for example, a URL ending in `/15` uses `15`). Recreate the container after changing either value. Each successful local backup is gzip-compressed and sent silently. Telegram delivery failure never invalidates or removes the local backup. `/backup` shows both local and Telegram delivery timestamps.

Downloaded files end in `.sqlite.gz`. Decompress before the normal stopped-service restore:

```sh
gunzip mailbot-CHOSEN.sqlite.gz
```

The database contains retained email bodies, AI results, learned rules and their audit events, Telegram IDs, drafts, and durable outbound content. Keep the destination private and restrict membership. No mailbox password, bot token, or AI API key is stored in SQLite.

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

### Conversational assistant staged release

Before this release, record the deployed commit/image and run the WAL-safe `/backup` flow. Download and open one produced backup with the current binary; do not copy the live SQLite file. Keep `AUTOMATION_MODE=off` for the first deployment. Migrations 6–10 are additive and preserve existing mail/card IDs; no Inbox re-import or card republish is required.

Run the synthetic real-model verifier before starting the bot image:

```sh
docker compose build mailbot
docker compose run --rm --no-deps --entrypoint node mailbot dist/verify-ai.js
```

The one-off verifier does not initialize Telegram polling, IMAP, SMTP, or the database. After deployment, verify health, `/status`, `/search`, `/memory`, and `/tasks` without mail writes. Only after separate approval should `AUTOMATION_MODE=observe` be enabled. Observe controlled new mail before a later, separately approved switch to `execute`.

For code rollback, set `AUTOMATION_MODE=off`, check out the recorded previous commit/image, rebuild, and recreate only `mailbot`; preserve the named volume. The old binary ignores additive tables, while tasks, memories, and policy data remain available for a later forward upgrade. Restoring an older database would discard state created after deployment and is therefore an emergency decision, not the default rollback. No code/database rollback can reverse an email already moved or an SMTP message already accepted.

## Troubleshooting

- **IMAP `ECONNREFUSED`:** test DNS and TCP reachability from inside the container. An internal hostname must resolve to the internal address there; Docker cannot bypass firewall/routing policy.
- **Telegram `ECONNREFUSED`:** the host/network is blocking `api.telegram.org:443`. Fix routing, proxy, or firewall; repeated container restarts will not solve it.
- **AI proxy returns 404 at `/v1`:** a base endpoint may legitimately return 404. Test `/v1/chat/completions`; AI failure is non-blocking and falls through according to `AI_PROVIDER_ORDER`.
- **Voice button is missing:** set `VOICE_REPLY_ENABLED=true`, configure `STT_BASE_URL`, `STT_API_KEY`, and at least one `STT_MODEL_ORDER` entry, then recreate the container. A restart does not load changed Compose environment values unless the container is recreated.
- **Voice transcription fails:** test the exact `/v1/audio/transcriptions` endpoint with multipart `file`, `model`, and `response_format=json`. With `STT_LANGUAGE=auto`, omit `language`; this is recommended for mixed Persian-English speech. Do not manually set the multipart Content-Type boundary. Health exposes successful and failed model names without audio, transcript, or API key.
- **English words are transliterated incorrectly:** keep `STT_LANGUAGE=auto`, inspect both raw outputs, and use transcript correction when confidence is low. The adjudicator may restore a Latin term only when at least one ASR candidate supports it.
- **Voice feels slow:** structured logs record content-free `durationMs` separately for each ASR model, transcript adjudication, and the complete post-upload review path. The interval before `Voice instruction received` includes user recording/upload time and is not ASR latency.
- **Voice is ignored:** send it as Telegram Reply to the exact Voice prompt for that mail. Duration and size limits are checked before download; text sent to a Voice prompt is rejected deliberately.
- **Ollama unavailable:** confirm the host listener accepts Docker traffic and use `host.docker.internal`, not container loopback.
- **Reply delivered but no sent copy:** verify `IMAP_SENT_MAILBOX` and APPEND permission. The transaction remains at the Sent-copy stage and does not blindly repeat accepted SMTP.
- **Ambiguous SMTP attempt:** inspect the configured sent mailbox for the persisted Message-ID before any manual retry. Duplicate prevention intentionally wins over automatic resend.
- **Telegram and Inbox counts differ:** one Telegram card now represents one exact pending thread, so fewer cards than Inbox messages is expected. `/status` and health expose `pendingThreads` and `pending` separately. External moves are confirmed twice before cleanup; ensure `TEST_IMPORT_LIMIT=0`.
- **Old Telegram card cannot be deleted:** Telegram limits deletion of old messages. Rotation reduces this risk, but prolonged bot downtime can exceed that window.
- **Signature images still appear as attachments:** inspect `classificationReason` through the hidden-image review, retain a sanitized MIME sample, and add a regression fixture. Do not globally hide all small images because screenshots may be legitimate attachments.
- **Calendar shown as a generic attachment:** confirm the MIME part is actually `text/calendar`. Version 0.5.0 ignores filenames such as `invite.ics` or `attachment-1`, refetches legacy Inbox payloads once, and renders structured ICS data. Remove any local mail rule that auto-moves all calendar messages if invitations should stay actionable in Telegram.
- **Calendar response fails:** the configured `SMTP_FROM` must be an Attendee and the invitation must contain UID and Organizer. As with Reply, inspect the stable Message-ID in Sent before manual recovery; accepted SMTP is never repeated blindly.
- **Calendar has no RSVP buttons:** cancelled/non-request calendar payloads intentionally expose only Done/Ask AI. For a request, verify UID, Organizer, and that `SMTP_FROM` appears among Attendees.
- **A real image was hidden:** use `Review hidden images`; the file remains retrievable and is not forwarded by default. Classification changes require refetching that Inbox message or receiving a new copy.
- **Thread has unrelated messages:** version 0.4.0 never merges by subject. Retain sanitized `Message-ID`, `In-Reply-To`, and `References` headers for diagnosis; malformed or reused sender IDs cannot be repaired safely by subject guessing.
- **Wrong خانم/آقای in an AI draft:** unknown recipients must be neutral. For a verified person only, copy `config/honorifics.example.json` to ignored `config/honorifics.json`, use the lowercase email as key, and restart. Never commit the real directory.
- **Bot ignores typed instructions:** free-form input must be sent using Telegram Reply to either the exact mail card or the prompt produced for that mail. Direct card replies support Ask, Reply, Reply All, Forward, Cancel, and exact-snapshot Archive. A clear Archive sentence is authorization for that selected target; ambiguous or conflicting requests receive one clarification question. Unbound text is still deliberately ignored when several mails could be selected.
- **Automation did not archive a matching mail:** verify `AUTOMATION_MODE=execute`, the policy is active and scoped to the receiving account, and the mail arrived after execute mode activation. Exceptions, high/critical importance, self/shared action ownership, and non-informational analysis deliberately prevent execution. Use the natural-language «چرا خودکار نشد؟» action on the card or inspect `/automations`; do not remove safety gates by editing SQLite.
- **Ask AI reports unsupported attachment:** current extraction supports PDF, DOCX, XLSX, HTML, and text/CSV-like formats. Images require OCR; legacy DOC/XLS require a future isolated converter.
- **AI feels stuck:** the primary Telegram card changes immediately to a progress state. Each provider is limited by `AI_TIMEOUT_MS` (45 seconds by default) before fallback; structured logs include the nested network code and cause.
- **Brief IMAP warning followed by restored:** Exchange or the network closed the long-lived session. Reconciliation waits for the reconnect supervisor and retries automatically; investigate only when health remains `503` or reconnect does not follow.
- **An account shows `Polling fallback`:** the server did not advertise the IMAP IDLE capability. ImapFlow falls back to its built-in polling behavior and the application's periodic Inbox reconciliation remains active; do not add a manual `client.idle()` loop.
- **Telegram polling is stale:** health returns `503` after two minutes without a successful poll. Verify host and container DNS resolution plus TCP/443 reachability to `api.telegram.org`; a successful IMAP connection alone is not sufficient health.
- **SELinux denies `mail-rules.json`:** current Compose uses a private `Z` relabel on the read-only config bind mount. Keep the project/config path dedicated to this service on enforcing AlmaLinux/RHEL hosts.
- **AI job is failed:** health reports job counts and provider status. A background analysis becomes terminal after five provider failures; the email remains fully usable and interactive Ask AI can be retried later.
- **Telegram cleanup job is failed:** the source mail action is already complete and must not be repeated. Telegram message IDs remain durable; restore Bot API access and let the cleanup job retry or inspect `/failed`.
- **Telegram backup is missing:** confirm `BACKUP_TELEGRAM_CHAT_ID`, bot posting rights, compressed size, and `/backup`. The local online backup remains authoritative.
- **A learned analysis rule is wrong:** use `/rules` and pause the exact numbered rule. Rules are account-scoped, reversible, and cannot move or send mail. Reanalyze an affected email after disabling a rule if a fresh AI result is required.
- **Operational status is needed:** use `/status`, `/accounts`, `/failed`, `/backup`, `/rules`, `/memory`, `/tasks`, `/automations`, `/search`, `/diagnose`, or `/sync`. Responses have a Close button and the original command is removed when the bot has deletion permission.
- **AI returns the old greeting/closing:** version 0.3.1 normalizes generated output after the provider response. Confirm the running image/version and rebuild/redeploy; manually edited text is intentionally preserved verbatim.
- **Restart loop:** inspect the first fatal log entry, validate `.env` with `docker compose config`, and test required destinations from inside the container.
