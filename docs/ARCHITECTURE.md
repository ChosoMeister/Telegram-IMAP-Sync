# Architecture

```text
IMAP account runtimes ──> reconciliation/IDLE ──> MIME + attachment/calendar classification ──> scoped rules ──> SQLite
                                                               │
                                  AI providers <────────────────┤
                                                               │
Telegram long polling <── action controller <──────────────────┘
        │                         │
        ├── full body/files       ├── atomic lock ──> IMAP MOVE + verification
        ├── Ask AI ──> document extraction / thread lookup
        ├── Voice ──> Telegram file ──> parallel ASR ──> AI consensus ──> transcript approval ──> draft review
        └── reply/calendar workflow ──> durable RFC822 ──> SMTP ──> Sent APPEND ──> IMAP MOVE
```

The service uses direct adapters rather than coupling domain state to a bot framework. SQLite runs in WAL mode and stores mail identity, exact RFC-derived thread keys, normalized attachment classification, AI results, immutable Telegram message-to-mail references, accepted inbound Telegram commands, update offsets, mail-scoped conversations with exact ForceReply prompt IDs, outbound transactions, action locks, user-confirmed learned analysis rules and their audit events, schema migrations, and durable jobs. Navigating a different card cannot clear another mail's draft or AI question.

The container is read-only except for `/data` and `/tmp`, drops Linux capabilities, binds health only to loopback on the host, and uses a named volume for portability across Linux, macOS, and Windows Docker hosts.

## Recovery

- Startup and periodic reconciliation list Inbox UIDs, then fetch and parse full MIME only for identities not already stored in SQLite.
- A persisted pending item without a Telegram message is republished from SQLite, so an interrupted Bot API delivery does not require downloading MIME again.
- IMAP disconnects make the health endpoint return `503`; a supervisor reconnects with capped exponential backoff and immediately reconciles after recovery.
- ImapFlow Auto-IDLE remains enabled by default. Per-account health distinguishes an active IDLE session, the short connected period before Auto-IDLE starts, a server without IDLE using ImapFlow's polling fallback, and reconnecting/unavailable transport. The application does not run a competing manual `idle()` loop.
- Text and Voice updates are deduplicated and persisted in a durable command queue before their Telegram offset advances. A leased command is retried after a crash or transient failure and becomes terminal after bounded attempts.
- Callback offsets advance only after successful handling. A failed callback is fetched again instead of being silently skipped.
- Every primary card has a `(chat_id,message_id)` reference to an immutable set of mail row IDs. Card rotation deactivates but retains the old reference, so a delayed Reply cannot be rebound to a newer email. Migration backfill registers existing cards without republishing them.
- Free text sent as a direct Reply to a known card enters an AI-backed, Zod-validated planner. The model can only produce bounded symbolic actions (`ask`, `archive`, `draft_reply`, `draft_forward`, `cancel`) against `this_mail` or the immutable card snapshot; it cannot emit mail IDs, SQL, shell commands, recipients, or a send action.
- Plans, exact scope, state, and per-action results are persisted in SQLite. Ambiguous or conflicting plans create one durable ForceReply clarification bound to the same mail. Invalid/unavailable AI planning falls back to a narrow deterministic router.
- A clear direct Archive command authorizes only the exact selected row or immutable snapshot and reuses the current IMAP adapter. It never expands to messages that arrived in the RFC thread after the referenced card. Draft actions reuse the existing review flow, so the planner cannot send email without the existing final approval.
- An expired callback acknowledgement after restart is ignored so the replayed idempotent action can still finish before its offset is persisted.
- Long-running per-mail actions edit the primary card immediately, use an atomic lock, and retain a short cooldown after completion so queued duplicate callbacks cannot repeat uploads or AI work.
- Reconciliation is deferred while IMAP is unavailable; the reconnect supervisor performs the retry after restoring the mailbox session.
- Readiness requires both fresh IMAP reconciliation and a successful Telegram poll within two minutes; startup receives a 90-second Telegram grace period.
- Duplicate IMAP events are harmless because of the unique identity constraint.
- Only exact normalized Message-ID relationships form a thread. The newest pending Inbox member owns the Telegram card; older member cards are removed, and Done/Reply/Forward archive the actionable group together.
- Telegram API rate limits honor `retry_after`; transient retries are limited to operations that cannot create duplicate chat messages.
- Mailbox/outbound completion is committed before Telegram deletion. Cleanup is a separate durable job, so a Bot API failure cannot repeat Archive or SMTP and retains the tracked Telegram IDs for retry.
- Pending items absent from Inbox on two consecutive reconciliations are treated as externally completed and their Telegram content is removed.
- SQLite uses its online backup API; retention is applied inside `/data/backups` without copying a live WAL database file directly. An optional gzip-compressed copy can be delivered to a dedicated private Telegram chat after local backup success.
- SMTP-success/Sent-copy-pending and Sent-copy-success/archive-pending are distinct states, so retries cannot duplicate the reply.
- Calendar Accept/Tentative/Decline reuses the same durable outbound stages and atomic lock; the stored iTIP response fixes UID, Sequence, Organizer, attendee, and PARTSTAT across retries.
- AI results are optional and can be regenerated after restart.
- Learned analysis rules are account-scoped and match only a normalized exact sender, sender plus normalized exact subject, or sender domain. More-specific matches win per effect. They are trusted guidance before AI and deterministic constraints after AI, but cannot trigger SMTP, IMAP MOVE, Archive, deletion, or Telegram cleanup.
- Structured assistant memories store kind, stable key, statement, global/account scope, source, confidence, status, and optional source mail/plan. Only active confirmed memories enter AI guidance. Inferred memories remain inspectable but non-authoritative; an explicit correction supersedes the previous active value instead of leaving contradictory guidance.
- `informational` and `not mine` describe action ownership, not importance. Informational corrections preserve the model/user importance, score, risk, and notification urgency unless a separate importance rule changes them.
- Voice instructions reuse exact ForceReply prompt binding, are bounded by duration and bytes before download, and remain in memory only. Configured ASR models run concurrently; healthy outputs are conservatively reconciled with bounded email context, while partial model failure remains usable. Transcript approval is independent from draft approval and SMTP approval.
- AI output passes through a provider-independent Persian style normalizer; therefore fallback-provider changes cannot reintroduce disallowed greetings or closings.
- Optional trusted owner identity is added to AI context. Analysis records whether an action belongs to self, another person, both, or is unknown; a deterministic alias-aware pass prevents the owner from being presented in third person.
- Reply output also passes through a gender-safety normalizer: it strips unverified gendered titles and applies only an optional exact email-address override.
- AI analysis jobs are leased from SQLite; abandoned leases return to the queue and repeated provider failures are bounded.
- Periodic reconciliation, rotation, cleanup, retention, and backup tasks suppress overlapping executions and report rejected overlaps or task failures.
- Legacy Inbox payloads missing attachment classification are refetched once and their existing Telegram cards are edited in place.
- Legacy Inbox calendar payloads without structured event metadata are refetched once; ICS fields are parsed deterministically and the existing card is edited without waiting for AI.
- Thread lookup temporarily opens Inbox/Archive/Sent mailboxes and restores the configured Inbox before normal reconciliation resumes.
- Completed local rows expire according to `DATA_RETENTION_DAYS`; mailbox content is not deleted by this cleanup.

## Known boundaries

- Telegram Bot API cannot delete messages older than 48 hours. Queue rotation minimizes, but cannot eliminate, this risk during prolonged downtime.
- Exchange folder naming and `MOVE` capability are installation-specific and require live discovery.
- Sent-copy storage requires IMAP APPEND permission on the configured sent mailbox (commonly `Sent Items` on Exchange).
- The default public Bot API accepts files up to 50 MB. The current requirement is at most 25 MB.
- PDF/DOCX extraction parses untrusted documents in memory. Independent file/context limits reduce resource exposure, but document analysis should still be enabled only for trusted organizational mail flows.
- The service uses Node's built-in SQLite API, which Node 22 still labels experimental; the database format itself is standard SQLite and online backups are used for recovery.
- Independent IMAP/SMTP accounts share one Telegram dispatcher. Mail identity and RFC thread keys are account-scoped, and every outbound or mailbox action resolves the immutable account on the stored mail row. See [Multi-account design](MULTI_ACCOUNT_DESIGN.md).
