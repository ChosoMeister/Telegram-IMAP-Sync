# Changelog

## 0.3.2 - 2026-08-19

- Defer Inbox reconciliation while IMAP is disconnected and classify disconnect-interrupted scans as recoverable warnings.
- Preserve nested network error causes and codes in redacted AI and IMAP diagnostics.
- Show immediate same-card progress for attachment retrieval, AI questions, Forward drafts, thread retrieval, and tone changes.
- Suppress concurrent and queued duplicate long-running Telegram actions without adding chat messages.
- Reduce the default per-provider AI timeout to 15 seconds for faster fallback.

## 0.3.1 - 2026-08-19

- Enforce polished administrative Persian across analysis, Reply, Forward, Thread summary, and Ask AI.
- Require `با درود و مهر` instead of `با سلام و احترام`/`با سلام` and `با سپاس` instead of `با تشکر`.
- Add deterministic output normalization so local and organizational models follow the same wording even when prompt compliance fails.
- Normalize Arabic `ي` and `ك` glyphs to Persian `ی` and `ک` in AI-generated text.
- Keep direct user edits untouched and retain the no-signature policy.

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
