# Architecture

```text
Exchange IMAP ──> reconciliation/IDLE ──> local mail rules ──> MIME normalization ──> SQLite
                                                               │
                                  AI providers <────────────────┤
                                                               │
Telegram long polling <── action controller <──────────────────┘
        │                         │
        ├── full body/files       ├── IMAP MOVE + verification
        └── reply workflow ──> SMTP reply ──> Sent APPEND ──> IMAP MOVE
```

The service uses direct adapters rather than coupling domain state to a bot framework. SQLite runs in WAL mode and stores mail identity, normalized metadata, AI results, Telegram message IDs, update offsets, and mail-scoped reply/forward drafts. Navigating a different card cannot clear another mail's draft.

The container is read-only except for `/data` and `/tmp`, drops Linux capabilities, binds health only to loopback on the host, and uses a named volume for portability across Linux, macOS, and Windows Docker hosts.

## Recovery

- Startup and periodic reconciliation list Inbox UIDs, then fetch and parse full MIME only for identities not already stored in SQLite.
- A persisted pending item without a Telegram message is republished from SQLite, so an interrupted Bot API delivery does not require downloading MIME again.
- IMAP disconnects make the health endpoint return `503`; a supervisor reconnects with capped exponential backoff and immediately reconciles after recovery.
- Telegram update offsets are persisted after each handled update.
- Duplicate IMAP events are harmless because of the unique identity constraint.
- Telegram API rate limits honor `retry_after`; transient retries are limited to operations that cannot create duplicate chat messages.
- Failed Done operations remain visible and retryable.
- Pending items absent from Inbox on two consecutive reconciliations are treated as externally completed and their Telegram content is removed.
- SQLite uses its online backup API; retention is applied inside `/data/backups` without copying a live WAL database file directly.
- SMTP-success/Sent-copy-pending and Sent-copy-success/archive-pending are distinct states, so retries cannot duplicate the reply.
- AI results are optional and can be regenerated after restart.

## Known boundaries

- Telegram Bot API cannot delete messages older than 48 hours. Queue rotation minimizes, but cannot eliminate, this risk during prolonged downtime.
- Exchange folder naming and `MOVE` capability are installation-specific and require live discovery.
- Sent-copy storage requires IMAP APPEND permission on the configured sent mailbox (commonly `Sent Items` on Exchange).
- The default public Bot API accepts files up to 50 MB. The current requirement is at most 25 MB.
- The service uses Node's built-in SQLite API, which Node 22 still labels experimental; the database format itself is standard SQLite and online backups are used for recovery.
