# Multi-account All Inbox design

## Intended behavior

One process and one private Telegram bot present a combined chronological action queue across independent mail servers. Every card retains an immutable `accountId`. Reply, Reply All, Forward, calendar RSVP, Sent APPEND, Archive, attachment fetch, and thread lookup always use that card's account runtime. A reply therefore leaves through the SMTP identity that received the message and is stored in that same account's Sent folder.

Running one container per account with the same bot token is explicitly unsupported: competing Telegram long-poll consumers can steal updates from each other and cannot safely route callbacks.

## Runtime shape

```text
Account A IMAP/SMTP ─┐
                     ├─> account-scoped ingest/state ─> one ordered Telegram dispatcher
Account B IMAP/SMTP ─┘                                      │
                     <─ account-scoped Reply/RSVP/Archive ──┘
```

- A single Telegram update loop owns the bot token and user authorization.
- An `AccountRuntime` map owns one supervised IMAP session, SMTP transport, folder discovery result, and health record per enabled account.
- A failure in one account is isolated: its cards remain visible and retryable while other accounts continue syncing.
- Cards show a compact account label so the outbound identity is obvious before confirmation.
- Ordering uses received time across all accounts; the existing pending-card refresh preserves the combined oldest-to-newest queue.
- Mail rules and optional identity metadata may be global with per-account overrides.

## Required data migration

Add an immutable `account_id` to mail, outbound transaction, job, and related action state. IMAP uniqueness becomes `(account_id, mailbox, uid_validity, uid)`. Thread keys are account-scoped by default so identical or malformed Message-IDs on different servers never merge. All existing rows migrate to the configured primary account without losing Telegram message IDs or pending state.

Callbacks continue to carry the local mail row ID; the row resolves the account before any network operation. No request may fall back to a global SMTP or IMAP client. Health and `/status` report every account separately plus an aggregate state.

## Configuration direction

A future ignored `config/accounts.json` will hold an array of account IDs, display labels, IMAP/SMTP endpoints, users, sender addresses, and folder paths. Environment-variable secret references or a separate ignored secret file should be supported so passwords do not enter Git. The existing singleton environment variables remain a backward-compatible primary account during migration.

## Safe delivery sequence

1. Introduce the account schema and migrate the current account as `primary`; prove no change to existing cards and actions.
2. Refactor adapters behind `AccountRuntime` while still running only `primary`; regression-test Reply, Forward, RSVP, Sent, Archive, recovery, and thread lookup.
3. Add the second account in dry-run, validate folder discovery and import a bounded test message without Telegram notification noise.
4. Enable combined delivery, verify account badges and controlled replies from each identity, then enable destructive actions for the second account.
5. Back up SQLite and configuration before each production phase and retain an immediate single-account rollback path.

## Inputs needed for each additional account

- Stable account ID and short Telegram label
- IMAP host, port, TLS mode, username, and secret reference
- SMTP host, port, TLS mode, username, sender address, and secret reference
- Exact Inbox, Archive, and Sent folder paths after live discovery
- Optional organization/job title for AI identity and optional account-specific mail rules

## Implemented behavior

Version 0.9.0 uses one uniform file per account. `MAIL_ACCOUNT_FILES` lists Orchid, Axon, and future accounts in order; the first entry is primary. No mailbox host, username, password, sender, or folder remains in global `.env`. Existing rows keep their immutable account ID while Telegram IDs and pending state remain unchanged.

Mail rules currently run only for the primary account. This is deliberate: organization-specific folders and routing must not be copied to another server without explicit per-account rules.
