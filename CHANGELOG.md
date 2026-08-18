# Changelog

## 0.2.0 - 2026-08-19

- Reconcile Telegram cards when mail is moved out of Inbox by another client.
- Add automatic IMAP reconnect and IMAP-aware health/status telemetry.
- Fetch full MIME only for new UIDs and recover interrupted Telegram delivery from SQLite.
- Keep Reply and Forward drafts scoped to their source mail.
- Persist stable outbound Message-ID and RFC822 payload before SMTP.
- Honor Telegram rate limits and rotate pending cards without deleting the old card first.
- Add online SQLite backups with retention and documented restore behavior.
- Add Docker log rotation and multi-architecture GitHub CI.
- Normalize nullable AI deadlines and use the discovered Exchange `Sent Items` path.
