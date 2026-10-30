# Telegram Forum Action Workspace — Implementation Plan

## Goal

Keep one account-agnostic All Inbox topic while moving only multi-step work (Reply, Reply All, Forward, Voice, and Ask AI) into a durable Actions topic. Private-chat behavior remains the default and no mailbox action is allowed to depend on Telegram cleanup succeeding.

## Decisions and boundaries

- `TELEGRAM_OWNER_USER_ID` authorizes actions; `TELEGRAM_CHAT_ID` selects delivery. Legacy `TELEGRAM_USER_ID` remains a deprecated fallback for one release.
- Forum mode is opt-in. Missing topic configuration preserves the current single-chat, same-card workflow.
- Inbox cards never disappear while mail is pending. Opening work creates an Actions card and compacts the Inbox card to `در حال اقدام` with Continue/Cancel.
- Telegram cannot move messages between topics; the implementation uses two durable message references and a state transition.
- Done, Archive, attachment/body viewing, AI-analysis retry, and short calendar confirmation remain in Inbox. Only multi-step workflows use Actions.
- One active action session is allowed per logical pending mail thread. Other group members may see mail in a private group but can never invoke actions.
- Search and System topics are future routing consumers, not part of this delivery.

## Work plan

### 1. Freeze contracts and create rollback evidence

- Record the current private-chat behavior, callback formats, SQLite schema version, Telegram cleanup invariants, and Reply/Forward transaction stages in `docs/SPEC.md`.
- Take a WAL-safe production backup and retain the currently deployed image/tag before enabling any schema migration.
- Add an ADR documenting shared All Inbox plus a temporary Actions workspace versus per-account topics and in-place-only navigation.
- Verify: current 92-test baseline, build, docs check, and production health are green before code changes.

### 2. Separate authorization from Telegram destinations

- Add `TELEGRAM_OWNER_USER_ID`, `TELEGRAM_CHAT_ID`, `TELEGRAM_INBOX_THREAD_ID`, and `TELEGRAM_ACTIONS_THREAD_ID`; accept negative supergroup IDs and positive topic IDs.
- Treat `TELEGRAM_USER_ID` as legacy owner and private-chat destination only when the new values are absent; reject partial/ambiguous Forum configuration at startup.
- Introduce `TelegramDestination { chatId, threadId?, surface }` and make send/edit/delete/document methods destination-aware instead of reading a global user ID.
- Extend Telegram update types with `message_thread_id` and topic metadata; authorize by owner ID and an allowlist of configured chat/topic destinations.
- Update preflight to inspect destination chat type, bot membership/permissions, Forum status, and configured topic delivery; fail closed rather than silently routing sensitive mail elsewhere.
- Verify: existing private-chat tests remain byte-for-byte equivalent; unauthorized users/chats/topics are ignored.

### 3. Add durable destination and action-session storage

- Add schema migration 6 with normalized `telegram_message_refs` keyed by `(chat_id,message_id)` and fields for `mail_id`, `thread_id`, `surface` (`inbox|action`), and role (`primary|prompt|auxiliary`).
- Add `telegram_action_sessions` keyed by logical mail thread/account with current representative mail ID, owner, kind, state, destination, primary action message, context fingerprint, timestamps, and last error.
- Add `prompt_chat_id` and `prompt_thread_id` to conversations so identical message IDs in different chats/topics cannot bind user text or Voice to the wrong email.
- Backfill existing Inbox message IDs at application startup using the configured legacy/default Inbox destination while retaining `telegram_ids_json` as a one-release rollback shadow for Inbox cards.
- Provide atomic Store methods for create/open/activate/cancel/fail/complete session and replace per-mail message references; never scatter multi-step SQL through the controller.
- Verify: migrate a copy of an older production-like DB, reopen it, back it up/restore it, and prove legacy cards remain editable and cleanable.

### 4. Build destination-aware Telegram delivery

- Refactor publish, enrich, rotation, attachment delivery, command results, cleanup jobs, and callback edits to resolve their stored destination.
- Ensure every new message in a Forum topic includes `message_thread_id`; edits/deletes use persisted `chat_id` and `message_id`.
- Add a verified Continue link for private supergroups; if a safe Telegram message link cannot be constructed, use a callback that identifies the Actions message without pretending it can navigate automatically.
- Keep the 48-hour queue rotation scoped to Inbox cards; active Action sessions use durable cleanup and expose stale-session recovery rather than reordering the Inbox.
- Verify: same message ID in two destinations cannot edit/delete the wrong message; 429 and missing-message recovery remain idempotent.

### 5. Implement the action-session state machine

- States: `opening → active → cancelling|sending → completed|failed|stale_context`; terminal cleanup is a durable job.
- Opening sequence: persist `opening`, create Actions card, persist its reference, compact Inbox card, then mark `active`. If send outcome is ambiguous, do not blindly create another card after restart.
- Actions card shows account, sender, subject, concise summary, current workflow stage, and Back/Cancel; all draft, tone, instruction, Voice, recipient, preview, and retry UI edits this card.
- Inbox card remains Pending and compact, with Continue and Cancel. Repeated Reply/Forward clicks resume the existing session instead of creating duplicates.
- Cancel marks the session cancelled first, clears conversation/prompt state, restores the Inbox summary, and queues deletion of all Actions messages. It never calls SMTP, IMAP MOVE, Sent APPEND, or Archive.
- Successful Reply/Forward preserves the existing durable SMTP → Sent → Archive transaction; only after completion are both Inbox and Actions references queued for deletion.
- Failure keeps Inbox visibly pending and the Actions card retryable. Topic deletion/closure never removes or completes the source email.
- Verify every transition with crash injection before and after Telegram send/edit/delete and before each outbound/mailbox stage.

### 6. Protect against changing email-thread context

- Compute a context fingerprint from account ID, logical thread key, current representative Message-ID, and ordered pending thread members when a draft session begins.
- When a new reply becomes the representative, link it to the existing logical session, mark the draft `stale_context`, and update both cards.
- Before final send, compare the stored fingerprint with live pending thread context. If it changed, block SMTP and require Refresh/Regenerate or explicit re-review of recipients and final text.
- Ensure successful completion archives the then-current actionable thread only after the reviewed context is current.
- Verify a new inbound reply arriving during AI generation, Voice transcription, final preview, and SMTP retry cannot send an obsolete draft silently.

### 7. Route each multi-step workflow through Actions

- Reply/Reply All: create/resume session, generate and edit draft in Actions, show final recipients/body, then use existing outbound stages.
- Forward: collect recipients with ForceReply in Actions, draft/edit the note there, preserve real attachments only, then use existing outbound stages.
- Voice: download/transcribe transiently, show consensus/manual correction in Actions, and retain the two independent approval gates.
- Ask AI: ask and render in Actions; Cancel returns to the unchanged Inbox card and stores no disposable answer as mailbox state.
- Ensure every ForceReply lookup includes owner, mail/session, prompt chat, and prompt topic; ordinary group messages are never treated as instructions.
- Verify parallel sessions for two emails remain isolated while a second click on the same email resumes its original session.

### 8. Recovery, observability, and operator controls

- On startup reconcile active sessions: restore missing compact Inbox UI, resume a known Actions card, flag ambiguous `opening`, and queue safe cleanup for cancelled/completed sessions.
- Extend health and `/status` with configured destinations, active/stale/failed session counts, without exposing email content or secret IDs in logs.
- Add `/sessions` under the System surface to list/resume/cancel stuck sessions; keep it dismissible and owner-only.
- Log state transitions with mail/session/account IDs and destinations, never bodies, drafts, Voice, tokens, or credentials.
- Include the new tables in existing online/Telegram backups and document restore/rollback limitations after Forum mode has produced Action cards.
- Verify container restart in every non-terminal state and a temporarily unavailable/closed Actions topic.

### 9. Test, documentation, and security gates

- Unit tests: config fallback/validation, destination resolver, link generation, state transitions, context fingerprints, prompt binding, and authorization.
- Integration tests: private chat, private Forum, duplicate Telegram message IDs across chats, topic send/edit/delete, cancellation, restart recovery, new inbound reply, and outbound stage failures.
- Security tests: non-owner callback/text/Voice, unconfigured group/topic, forwarded callback data, stale callback after cancel, and oversized Telegram input.
- Update `.env.example`, configuration, operations, architecture, multi-account design, SPEC, README, and deployment/rollback guidance; never commit real chat/topic/user IDs.
- Run `npm run check`, `npm audit --audit-level=high`, `git diff --check`, tracked-tree secret/confidentiality scan, and build the Docker image.

### 10. Staged rollout and acceptance

- Release A: deploy destination abstraction with Forum variables unset; confirm production private-chat behavior, Inbox/Card parity, Reply, Sent, Archive, rotation, and cleanup.
- Release B: enable a private test Forum with Inbox and Actions topics and one controlled non-critical email; validate bot permissions and every Cancel/success/failure path.
- Release C: enable production Forum routing, initially silent, reconcile every pending card, and verify Inbox count equals pending representatives with zero orphan Action sessions.
- Rollback: disable Forum routing only after cancelling/cleaning active sessions, retain DB/image backup, restore the prior image, and manually verify no Action-topic cards remain.
- Acceptance: All Inbox remains one ordered queue; Actions is empty when no workflow is active; Cancel restores Inbox without mailbox mutation; successful send archives exactly once and removes all related Telegram content; restart or topic failure never hides a pending email.

## Expected file impact

- `src/config.ts`, `.env.example`, account/preflight configuration
- `src/telegram/api.ts` plus destination/link helpers
- `src/store.ts` and domain types for migration 6, message references, and sessions
- `src/app.ts` split into destination routing and action-session workflow helpers
- Telegram render/buttons for compact Inbox and Actions cards
- New Store, Telegram routing, session, recovery, and workflow tests
- README and all operational/architectural documentation

## Explicit non-goals

- No per-account Inbox topics by default.
- No multi-user mailbox authorization or collaborative assignment.
- No Telegram webhook, Search implementation, automatic topic creation, or mailbox action on Cancel.
- No rewrite of the existing durable SMTP/Sent/Archive transaction.
