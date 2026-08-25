# Changelog

## Unreleased

- Update the proxy defaults and examples to the deployed `local-gpt-oss-120b` and `local-gemma4-26b` model names.
- Keep email cards usable during a full AI outage, show an explicit temporary-unavailable state after bounded retries, and automatically retry failed analysis after cooldown.
- Include bounded upstream HTTP error details in AI diagnostics without logging credentials or email content.
- Show an explicit failed-analysis state with a Telegram button that immediately resets and retries the durable AI job.

## 0.11.2 - 2026-08-22

- Distinguish `subscribe` from `unsubscribe` per local spoken context, resolve supported participant names without forcing Latin output, and add content-free per-model/judge timing telemetry for Voice diagnostics.

## 0.11.1 - 2026-08-22

- Prefer a configurable fast transcript judge independently from the regular email AI order, bound adjudication context to 8K characters, and improve conservative phonetic recovery for mixed Persian-English speech.

## 0.11.0 - 2026-08-22

- Replace first-success ASR fallback with parallel Qwen3-ASR and Whisper transcription for every Voice instruction; one failing model no longer prevents review of the healthy result.
- Default Voice language detection to automatic so mixed Persian-English speech can preserve supported Latin terms such as `unsubscribe`.
- Add conservative, email-context-aware AI adjudication with confidence and uncertain-term reporting while forbidding invention from email context.
- Require a separate transcript approval before drafting and add Telegram controls for correction, re-recording, and inspecting both raw model outputs.
- Keep source audio ephemeral and preserve the existing account-scoped Reply, Reply All, Forward, Sent, Archive, and final-send approval guarantees.

## 0.10.0 - 2026-08-22

- Document Gmail and Google Workspace as supported independent accounts using IMAP/SMTP, Google App Passwords, discovered folder paths, and the existing account-scoped All Inbox routing.
- Add Persian Telegram Voice instructions for Reply, Reply All, and Forward while preserving exact ForceReply-to-mail binding and final approval.
- Download bounded Voice payloads from Telegram in memory, transcribe through ordered OpenAI-compatible ASR models, and fall back from Qwen3-ASR to Whisper on timeout, HTTP failure, invalid JSON, or empty output.
- Display the extracted transcript beside the generated draft, expose STT health without content or secrets, and never persist source audio.
- Add production configuration validation, regression coverage, bilingual documentation, and operational troubleshooting for Voice/STT.

## 0.9.0 - 2026-08-19

- Move the primary mailbox out of global `.env` into the same ignored per-account format as every additional account.
- Make ordered `MAIL_ACCOUNT_FILES` the uniform registry; the first file is primary and future accounts require only one new file/list entry.
- Keep a deprecated singleton `.env` compatibility path while removing mailbox credentials from the production/global example.
- Update discovery, preflight, documentation validation, and operations guidance for the symmetric layout.

## 0.8.1 - 2026-08-19

- Add ordered fallback across multiple models exposed by one OpenAI-compatible AI proxy.
- Record health and the selected model separately as `proxy:<model>`.
- Configure GPT-OSS 120B as the quality-first primary and Gemma 4 26B as the faster fallback after production-compatible Persian analysis benchmarks.

## 0.8.0 - 2026-08-19

- Add a single-process Multi-IMAP/SMTP All Inbox with one Telegram update dispatcher.
- Scope IMAP identity, exact RFC threads, health, reconciliation, and all mailbox/outbound actions to an immutable account ID.
- Route Reply, Reply All, Forward, calendar RSVP, attachment/thread reads, Sent APPEND, and Archive through the account that received the mail.
- Add atomic migration of existing data to the configured primary account while preserving cards and pending state.
- Add ignored secondary-account env files with literal special-character parsing, account labels on cards, per-account `/status`, regression tests, and operational documentation.
- Keep organization-specific mail rules limited to the primary account until explicit per-account rules are configured.

## 0.7.0 - 2026-08-19

- Add an optional ignored owner profile containing names, aliases, owned addresses, organization, and job-title context without credentials.
- Extend AI analysis with explicit self/other/shared/unknown action ownership and direct second-person Persian wording for the owner.
- Add deterministic profile-alias normalization so a noncompliant model cannot keep presenting the owner as a third person.
- Label self and shared work clearly on Telegram cards and document the planned account-scoped Multi-IMAP All Inbox architecture.

## 0.6.0 - 2026-08-19

- Add real RFC 5546 Accept, Tentative, and Decline responses addressed to the event Organizer.
- Require same-card final confirmation before any calendar response leaves the system.
- Preserve UID, Sequence, recurrence identity, attendee identity, and PARTSTAT in the iTIP reply.
- Reuse durable SMTP, Sent APPEND, Archive, atomic-lock, and duplicate-prevention stages; invitations stay Pending until completion.
- Score calendar importance deterministically from cancellation/past state, response requirement, and proximity to the event instead of generic AI analysis.
- Simplify calendar UX to RSVP plus Done/Ask AI, removing misleading generic Reply, Reply All, Forward, and body actions.
- Synchronize bilingual README, configuration, operations, rules, specification, architecture, and maintenance guidance with the final calendar lifecycle.

## 0.5.0 - 2026-08-19

- Detect calendar messages deterministically from `text/calendar` even when Exchange names the part `attachment-1`.
- Parse ICS method, status, title, description, organizer, attendees, start/end, location, URL, and common Exchange/IANA time zones.
- Handle quoted Outlook timezone parameters containing a colon, including `(UTC+03:30) Tehran`.
- Render dedicated Persian invitation/update/cancellation cards and bypass misleading generic AI summaries for calendar mail.
- Exclude ICS payloads from normal and hidden attachment counts while retaining their structured data for AI context.
- Refetch legacy pending calendar messages once so existing Telegram cards are corrected in place.
- List attendee names on calendar cards, falling back to email only when a display name is absent, with a safe cap for unusually large invitations.

## 0.4.1 - 2026-08-19

- Add same-card, paginated `All message texts` with chronological sender, address, time, subject, and body sections.
- Keep a separate `Latest message` action and remove the redundant `Thread` button from every summary card.
- Show `All message texts` only for genuinely merged threads; single-message cards expose only `Message text`.
- Reorganize actions into mobile-friendly two-button rows, fully localize Reply All, shorten AI/content labels, and show attachment/hidden-item counts on lower-priority rows.
- Preserve old `Thread` callbacks as a safe compatibility alias for `All message texts` while existing cards are refreshed.

## 0.4.0 - 2026-08-19

- Consolidate exact RFC-related Inbox replies into one chronological Telegram card represented by the newest pending message.
- Archive all pending Inbox members together after Done, Reply, or Forward, while Reply targets the newest message.
- Bind instructions, edits, forwarding recipients, and AI questions to their exact Telegram ForceReply prompt to prevent cross-mail selection.
- Remove subject-only thread matching and use normalized Message-ID, In-Reply-To, and References relationships exclusively.
- Recreate stale/missing Telegram cards silently and keep thread cards correctly ordered when a new reply arrives.
- Prevent AI gender inference, strip unverified Persian gendered titles, and add an optional ignored per-address verified honorific map.
- Report pending thread cards separately from pending Inbox messages and expand regression coverage and documentation.

## 0.3.3 - 2026-08-19

- Increase the default AI provider timeout to 45 seconds for large organizational models and complex Reply generation.
- Mark the service unhealthy when successful Telegram polling is stale for two minutes, with a 90-second startup grace period.
- Add automatic SELinux relabeling for the read-only mail-rule bind mount on AlmaLinux/RHEL hosts.

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
