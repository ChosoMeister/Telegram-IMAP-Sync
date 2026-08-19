# Product specification

## Goal

Keep the user's Exchange Inbox as an actionable queue mirrored in a private Telegram bot. A Telegram item remains pending until the user completes it or sends a reply. Completion moves the source message out of Exchange Inbox and removes all related Telegram content.

## Invariants

1. IMAP identity is `(mailbox, UIDVALIDITY, UID)`; RFC Message-ID is metadata, not the deduplication key.
2. New mail is persisted before Telegram delivery.
3. Telegram delivery does not wait for AI. Analysis is best-effort and updates the item later.
4. Done archives and verifies the IMAP operation before deleting Telegram messages.
5. Reply requires a preview and explicit confirmation.
6. A successful SMTP reply is durably marked, copied to Sent, and then archived; retries never repeat an already-successful SMTP send.
7. Attachments are fetched on demand and are not retained on disk.
8. Inline signature images referenced by CID are not presented as user attachments.
9. Only the configured Telegram user ID can invoke actions.
10. Destructive actions are unavailable while `APP_MODE=dry-run`.
11. The exact outbound RFC822 payload and stable Message-ID are stored before SMTP; SMTP, Sent-copy, and completion stages are durable.
12. If the process dies during an SMTP attempt, automatic resend is blocked unless the stable Message-ID is already found in Sent; this favors duplicate prevention over an unsafe blind retry.
13. Done, Reply, Forward, and calendar RSVP acquire an expiring atomic per-mail lock before mutation.
14. Images classified as inline/signature/uncertain are excluded from the primary attachment count and Forward, but remain explicitly reviewable by the user.
15. Messages merge into a Telegram card only through exact normalized `Message-ID`, `In-Reply-To`, or `References`; subject similarity is never sufficient.
16. Free-form input is accepted only as a direct reply to the exact ForceReply prompt that opened its mail-scoped workflow.
17. Calendar identity comes from MIME `text/calendar`, never from an attachment filename or AI inference; its structured fields take precedence over generic analysis in the card.
18. When an owner profile is configured, AI treats its names and addresses as the bot user's identity, labels the action owner, and addresses self-assigned actions directly as `شما` rather than naming the user in third person.
19. Every mail belongs to one immutable account; all reads, replies, forwards, calendar responses, Sent copies, and Archive moves use that account. IMAP identities and threads never collide across accounts.

## Telegram lifecycle

- Initial import scans all messages currently in Inbox, oldest first.
- A new item contains sender, subject, time, AI summary/priority, suggested action, and real attachment count. A later Inbox reply in the same exact RFC thread replaces/recreates the representative card at the bottom and displays the pending messages as chronological sections.
- A single-message card exposes only `Message text`. A merged card exposes `Latest message` plus `All message texts`, which sections every pending Inbox body chronologically with sender address, time, and subject. Both paginate by editing the same Telegram card, with `Back` restoring the summary.
- Buttons follow a mobile-first hierarchy: Reply and green Done first; Forward and conditional Persian `Reply to all` second; content and AI next; counted attachments and hidden items last.
- `Attachments` retrieves real attachments from IMAP and sends them into the chat.
- `Hidden images` retrieves signature/inline/uncertain images only on demand; Back removes those temporary Telegram messages.
- `Ask AI` accepts a free-form question scoped to the current mail, extractable real attachments, or the discovered thread, and renders the answer on the same card.
- The summary card itself is the pending thread view, so it has no redundant `Thread` button. `Ask AI > whole thread` still searches Inbox, configured/discovered Archive, and configured/discovered Sent only by exact Message-ID relationships.
- A calendar message has a dedicated Persian card showing event type, title, organizer address, Tehran start/end, location or link, attendee names (email only as a missing-name fallback), description, and a deterministic action. Its ICS payload is not counted as a normal or hidden attachment. Invitations remain actionable until the user completes them.
- Calendar priority is deterministic and cannot be overridden by AI: cancelled/past events are low; unanswered requests within 24 hours are critical, within 72 hours high, within seven days normal with a higher score, and later requests normal.

## Calendar response lifecycle

1. A valid `METHOD:REQUEST` with UID, Organizer, and the configured sender in Attendees exposes `Accept`, `Tentative`, and `Decline`.
2. The first click opens a same-card confirmation screen; only explicit final confirmation creates one durable RFC 5546 `METHOD:REPLY` with matching UID/Sequence and attendee `PARTSTAT`.
3. The exact RFC822 payload is persisted before SMTP, sent only to Organizer, appended to Sent, and then all pending Inbox members are archived.
4. The Telegram card is removed only after every stage succeeds. Failure leaves the invitation visible with a retry for the incomplete response; ambiguous SMTP results are never blindly resent.
5. Calendar cards deliberately hide generic Reply, Reply All, Forward, and Message text actions. Valid requests show only RSVP plus Done/Ask AI; cancellations and non-actionable calendar payloads show only Done/Ask AI.
- All Telegram message IDs belonging to a mail are tracked for Done cleanup.
- Every 36 hours, the full pending queue is silently refreshed oldest-to-newest. Each replacement card is sent and persisted before the previous card is deleted, avoiding a gap if Telegram delivery fails and preserving visual order.
- If the bot is offline beyond Telegram's deletion window, old content may not be deletable; this is a platform limitation.
- Mail removed from Inbox by Outlook or another client is confirmed absent on two reconciliations, then its Telegram content is removed automatically.

## Reply lifecycle

1. Choose Reply or Reply All.
2. AI creates an initial formal draft using the current message context.
3. The user may change tone, give an instruction to AI, replace the text directly, regenerate, cancel, or approve.
   The initial draft and subsequent AI rewrites include the discovered thread context.
4. The final screen includes recipients and body.
5. Approval sends via SMTP with `In-Reply-To` and `References`.
6. After SMTP success, the state becomes `sent_pending_sentcopy` before the exact RFC822 message is appended to Exchange Sent.
7. After Sent storage succeeds, the state becomes `sent_pending_archive` before the source message is moved from Inbox.
8. A failure offers retry for only the incomplete stage; SMTP is never repeated after acceptance.
9. Archive success completes the item and removes its Telegram card without adding a separate success message.
10. Reply always targets the newest pending message in a merged thread; successful completion archives every pending Inbox member of that thread.

## Forward lifecycle

1. The user enters one or more recipient email addresses.
2. AI proposes a concise Persian forwarding note from the original email context.
3. The user may instruct AI, change tone, directly edit the note, cancel, or approve.
4. The forwarded message contains the note, original headers/body, and all real attachments while excluding inline signature images.
5. SMTP acceptance, Sent storage, source Archive, and Telegram cleanup use the same retry-safe staged transaction as Reply.

## AI

Providers are ordered through `AI_PROVIDER_ORDER`, for example `proxy,ollama` or `ollama,proxy`. Both analysis and reply drafting use the same fallback chain. Failure of every provider leaves the email usable without analysis. Email contents are never logged.

All user-visible AI values use polished administrative Persian. Generated mail must use `با درود و مهر` instead of `با سلام و احترام`/`با سلام`, and `با سپاس` instead of `با تشکر`. The system prompt states this policy for every provider, and a deterministic output normalizer enforces the replacements and Persian `ی`/`ک` before display or sending. The model must not infer gender: unknown recipients receive neutral wording, while optional verified per-address titles may be configured locally. Direct manual edits remain exactly as entered by the user.

The analysis contract is JSON containing importance, score, Persian summary, suggested action, optional deadline, reason, and `actionOwner` (`self`, `other`, `shared`, or `unknown`). Email content is untrusted data and must not override the system prompt or trusted local owner profile.

Background analysis is a durable SQLite job. A crash releases an expired lease for retry; provider failures use bounded exponential delay and become terminal after five attempts. Interactive questions remain recoverable through the persisted Telegram update offset and conversation state.

## Attachment classification

Classification uses MIME disposition, CID references, HTML usage, content type, filename patterns, byte size, and image dimensions; a SHA-256 fingerprint is retained for audit and future recurrence learning. Non-image files are real attachments. CID-referenced images are hidden even when a sender incorrectly labels them as ordinary attachments. Common signature/logo/icon names and small icon/signature geometry are also hidden. Explicit normal-sized image attachments remain real. Hidden items are never silently discarded: the user can inspect them, and returning to the summary removes only their temporary Telegram copies.

## Exchange discovery gate

Before live mode:

1. Verify TLS and authentication for IMAP and SMTP.
2. Read the server capability set.
3. List exact mailbox paths and special-use flags.
4. Select the existing Archive/Processed destination or create one only after user approval.
5. Test with one non-critical message.
6. Confirm the message leaves Inbox, remains searchable, and appears correctly in Outlook.
7. Verify SMTP Sent Items behavior and thread headers.

Only then set `APP_MODE=live`.
