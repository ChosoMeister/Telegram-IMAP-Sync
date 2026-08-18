# Changelog

## 0.3.0 - 2026-08-19

- Classify MIME attachments as real, inline, signature, or uncertain using CID, HTML references, names, type, size, and dimensions while recording SHA-256 metadata.
- Hide signature assets from the primary count and Forward while keeping an explicit on-demand review path.
- Refetch and reclassify legacy Inbox payloads once without creating replacement Telegram cards.
- Add free-form Ask AI over the current message, extractable PDF/DOCX/text attachments, or the complete thread.
- Discover threads across Inbox, Archive, and Sent and use thread context for summaries and reply drafts.
- Add expiring atomic mail-action locks, versioned SQLite migrations, and a durable background AI job queue.
- Add attachment/context resource limits, component health telemetry, and completed local-state retention.
- Continue idempotent actions when Telegram replays an expired callback after a restart.
- Treat Telegram's idempotent `message is not modified` response as healthy telemetry.
- Expand regression coverage and synchronize all English and Persian documentation.

## 0.2.0 - 2026-08-19

- Reconcile Telegram cards when mail is moved out of Inbox by another client.
- Add automatic IMAP reconnect and IMAP-aware health/status telemetry.
- Fetch full MIME only for new UIDs and recover interrupted Telegram delivery from SQLite.
- Keep Reply and Forward drafts scoped to their source mail.
- Persist stable outbound Message-ID and RFC822 payload before SMTP.
- Honor Telegram rate limits and rotate pending cards without deleting the old card first.
- Add online SQLite backups with retention and documented restore behavior.
- Add Docker log rotation and multi-architecture GitHub CI.
- Publish OCI revision metadata, provenance attestations, and multi-architecture images to GitHub Container Registry.
- Normalize nullable AI deadlines and use the discovered Exchange `Sent Items` path.
- Add complete configuration, operations, mail-rule, Persian, and maintenance documentation with automated drift checks.
