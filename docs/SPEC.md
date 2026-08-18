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

## Telegram lifecycle

- Initial import scans all messages currently in Inbox, oldest first.
- A new item contains sender, subject, time, AI summary/priority, suggested action, and real attachment count.
- `Full text` extracts plain text or sanitized HTML and paginates it by editing the same Telegram card, with `Back` restoring the summary.
- `Attachments` retrieves real attachments from IMAP and sends them into the chat.
- All Telegram message IDs belonging to a mail are tracked for Done cleanup.
- Every 36 hours, the full pending queue is silently refreshed oldest-to-newest. Each replacement card is sent and persisted before the previous card is deleted, avoiding a gap if Telegram delivery fails and preserving visual order.
- If the bot is offline beyond Telegram's deletion window, old content may not be deletable; this is a platform limitation.
- Mail removed from Inbox by Outlook or another client is confirmed absent on two reconciliations, then its Telegram content is removed automatically.

## Reply lifecycle

1. Choose Reply or Reply All.
2. AI creates an initial formal draft using the current message context.
3. The user may change tone, give an instruction to AI, replace the text directly, regenerate, cancel, or approve.
4. The final screen includes recipients and body.
5. Approval sends via SMTP with `In-Reply-To` and `References`.
6. After SMTP success, the state becomes `sent_pending_sentcopy` before the exact RFC822 message is appended to Exchange Sent.
7. After Sent storage succeeds, the state becomes `sent_pending_archive` before the source message is moved from Inbox.
8. A failure offers retry for only the incomplete stage; SMTP is never repeated after acceptance.
9. Archive success completes the item and removes its Telegram card without adding a separate success message.

## Forward lifecycle

1. The user enters one or more recipient email addresses.
2. AI proposes a concise Persian forwarding note from the original email context.
3. The user may instruct AI, change tone, directly edit the note, cancel, or approve.
4. The forwarded message contains the note, original headers/body, and all real attachments while excluding inline signature images.
5. SMTP acceptance, Sent storage, source Archive, and Telegram cleanup use the same retry-safe staged transaction as Reply.

## AI

Providers are ordered through `AI_PROVIDER_ORDER`, for example `proxy,ollama` or `ollama,proxy`. Both analysis and reply drafting use the same fallback chain. Failure of every provider leaves the email usable without analysis. Email contents are never logged.

The analysis contract is JSON containing importance, score, Persian summary, suggested action, optional deadline, and reason. Email content is untrusted data and must not override the system prompt.

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
