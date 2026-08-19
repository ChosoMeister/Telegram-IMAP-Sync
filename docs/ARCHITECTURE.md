# Architecture

```text
Exchange IMAP ──> reconciliation/IDLE ──> MIME + attachment classification ──> local mail rules ──> SQLite
                                                               │
                                  AI providers <────────────────┤
                                                               │
Telegram long polling <── action controller <──────────────────┘
        │                         │
        ├── full body/files       ├── atomic lock ──> IMAP MOVE + verification
        ├── Ask AI ──> document extraction / thread lookup
        └── reply workflow ──> thread context ──> SMTP reply ──> Sent APPEND ──> IMAP MOVE
```

The service uses direct adapters rather than coupling domain state to a bot framework. SQLite runs in WAL mode and stores mail identity, normalized attachment classification, AI results, Telegram message IDs, update offsets, mail-scoped conversations, outbound transactions, action locks, schema migrations, and durable jobs. Navigating a different card cannot clear another mail's draft or AI question.

The container is read-only except for `/data` and `/tmp`, drops Linux capabilities, binds health only to loopback on the host, and uses a named volume for portability across Linux, macOS, and Windows Docker hosts.

## Recovery

- Startup and periodic reconciliation list Inbox UIDs, then fetch and parse full MIME only for identities not already stored in SQLite.
- A persisted pending item without a Telegram message is republished from SQLite, so an interrupted Bot API delivery does not require downloading MIME again.
- IMAP disconnects make the health endpoint return `503`; a supervisor reconnects with capped exponential backoff and immediately reconciles after recovery.
- Telegram update offsets are persisted after each handled update.
- An expired callback acknowledgement after restart is ignored so the replayed idempotent action can still finish before its offset is persisted.
- Long-running per-mail actions edit the primary card immediately, use an atomic lock, and retain a short cooldown after completion so queued duplicate callbacks cannot repeat uploads or AI work.
- Reconciliation is deferred while IMAP is unavailable; the reconnect supervisor performs the retry after restoring the mailbox session.
- Duplicate IMAP events are harmless because of the unique identity constraint.
- Telegram API rate limits honor `retry_after`; transient retries are limited to operations that cannot create duplicate chat messages.
- Failed Done operations remain visible and retryable.
- Pending items absent from Inbox on two consecutive reconciliations are treated as externally completed and their Telegram content is removed.
- SQLite uses its online backup API; retention is applied inside `/data/backups` without copying a live WAL database file directly.
- SMTP-success/Sent-copy-pending and Sent-copy-success/archive-pending are distinct states, so retries cannot duplicate the reply.
- AI results are optional and can be regenerated after restart.
- AI output passes through a provider-independent Persian style normalizer; therefore fallback-provider changes cannot reintroduce disallowed greetings or closings.
- AI analysis jobs are leased from SQLite; abandoned leases return to the queue and repeated provider failures are bounded.
- Legacy Inbox payloads missing attachment classification are refetched once and their existing Telegram cards are edited in place.
- Thread lookup temporarily opens Inbox/Archive/Sent mailboxes and restores the configured Inbox before normal reconciliation resumes.
- Completed local rows expire according to `DATA_RETENTION_DAYS`; mailbox content is not deleted by this cleanup.

## Known boundaries

- Telegram Bot API cannot delete messages older than 48 hours. Queue rotation minimizes, but cannot eliminate, this risk during prolonged downtime.
- Exchange folder naming and `MOVE` capability are installation-specific and require live discovery.
- Sent-copy storage requires IMAP APPEND permission on the configured sent mailbox (commonly `Sent Items` on Exchange).
- The default public Bot API accepts files up to 50 MB. The current requirement is at most 25 MB.
- PDF/DOCX extraction parses untrusted documents in memory. Independent file/context limits reduce resource exposure, but document analysis should still be enabled only for trusted organizational mail flows.
- The service uses Node's built-in SQLite API, which Node 22 still labels experimental; the database format itself is standard SQLite and online backups are used for recovery.
