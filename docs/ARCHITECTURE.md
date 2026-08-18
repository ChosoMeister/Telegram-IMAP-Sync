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

The service uses direct adapters rather than coupling domain state to a bot framework. SQLite runs in WAL mode and stores mail identity, normalized metadata, AI results, Telegram message IDs, update offsets, and active reply state.

The container is read-only except for `/data` and `/tmp`, drops Linux capabilities, binds health only to loopback on the host, and uses a named volume for portability across Linux, macOS, and Windows Docker hosts.

## Recovery

- Startup always reconciles the complete Inbox against SQLite.
- Telegram update offsets are persisted after each handled update.
- Duplicate IMAP events are harmless because of the unique identity constraint.
- Failed Done operations remain visible and retryable.
- SMTP-success/Sent-copy-pending and Sent-copy-success/archive-pending are distinct states, so retries cannot duplicate the reply.
- AI results are optional and can be regenerated after restart.

## Known boundaries

- Telegram Bot API cannot delete messages older than 48 hours. Queue rotation minimizes, but cannot eliminate, this risk during prolonged downtime.
- Exchange folder naming and `MOVE` capability are installation-specific and require live discovery.
- Sent-copy storage requires IMAP APPEND permission on the configured `Sent` mailbox.
- The default public Bot API accepts files up to 50 MB. The current requirement is at most 25 MB.
