# Gmail and Google Workspace setup

Gmail and Google Workspace can be added as independent accounts in the same Telegram All Inbox. Mail received by Gmail is replied to through Gmail SMTP, appended to that Gmail account's Sent mailbox, and archived through that account's IMAP session. It does not share credentials, folders, or outbound identity with another account.

## Prerequisites

- IMAP access must be permitted for the Google account or Workspace organization.
- Enable Google 2-Step Verification.
- Create a Google App Password for this service. Do not use the normal Google account password.
- A Workspace administrator can disable App Passwords or restrict IMAP/SMTP access. In that case this password-based integration cannot connect until the policy is changed; OAuth is not currently implemented.

Google guidance: [Check Gmail through other email platforms](https://support.google.com/mail/answer/7126229) and [Sign in with App Passwords](https://support.google.com/accounts/answer/185833).

## Account file

Create an ignored file such as `config/account-gmail.env` from `config/mail-account.example.env`:

```dotenv
ACCOUNT_ID=gmail
ACCOUNT_LABEL=Gmail

IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_SECURE=true
IMAP_USER=your-address@gmail.com
IMAP_PASSWORD=your-16-character-app-password
IMAP_MAILBOX=INBOX
IMAP_ARCHIVE_MAILBOX=[Gmail]/All Mail
IMAP_SENT_MAILBOX=[Gmail]/Sent Mail

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-address@gmail.com
SMTP_PASSWORD=your-16-character-app-password
SMTP_FROM=your-address@gmail.com
```

For STARTTLS instead of implicit TLS, use:

```dotenv
SMTP_PORT=587
SMTP_SECURE=false
```

Use the full Gmail or Workspace address as `IMAP_USER`, `SMTP_USER`, and `SMTP_FROM`. Keep the App Password private; spaces shown by Google's UI may be omitted when storing it.

## Register the account

Append the file to the existing ordered registry in global `.env`:

```dotenv
MAIL_ACCOUNT_FILES=/app/config/account-orchid.env,/app/config/account-axon.env,/app/config/account-gmail.env
```

The first entry remains primary. Adding Gmail later does not change the immutable account identity of existing mail.

On Linux, protect the account file and make it readable by the container user:

```sh
sudo chown 10001:10001 config/account-gmail.env
sudo chmod 600 config/account-gmail.env
```

Docker Desktop file-sharing permissions differ on macOS and Windows; the essential requirement is that the mounted file is readable inside the container and is never committed.

## Discover and commission safely

Gmail commonly exposes Archive as `[Gmail]/All Mail` and Sent as `[Gmail]/Sent Mail`, but localized, Workspace, or server-side settings can differ. Discovery output is authoritative.

1. Keep `APP_MODE=dry-run` and temporarily use a bounded `TEST_IMPORT_LIMIT` if needed.
2. Recreate the service so the new account list is loaded.
3. Run discovery and confirm Gmail IMAP authentication, SMTP authentication, special-use folders, Archive, and Sent:

   ```sh
   docker compose run --rm --no-deps -e APP_MODE=dry-run mailbot node dist/discover.js
   ```

4. Run preflight and inspect per-account health:

   ```sh
   docker compose run --rm --no-deps -e APP_MODE=dry-run mailbot node dist/preflight.js
   docker compose up -d --force-recreate
   docker compose logs --tail 100 mailbot
   ```

5. Send one controlled message to Gmail. Confirm its Telegram account label, Reply sender, Gmail Sent copy, and thread headers.
6. Complete one non-critical message and confirm it leaves Inbox but remains searchable in Gmail under All Mail.
7. Restore `TEST_IMPORT_LIMIT=0` before production and enable live mode only after these checks pass.

Moving a Gmail message to the configured All Mail destination implements the intended archive behavior by removing it from the actionable Inbox while retaining it in the mailbox. Verify this once against the real account because Gmail exposes labels through IMAP folder semantics.

## Troubleshooting

- `535`, `534`, or authentication failure: verify that the credential is an App Password, 2-Step Verification is enabled, and Workspace policy permits App Passwords and IMAP/SMTP.
- App Password option is missing: Google can suppress it for organization policy, Advanced Protection, or some security-key-only configurations. Ask the Workspace administrator before changing the application.
- IMAP works but Sent or Archive fails: rerun discovery and copy the exact mailbox paths and capitalization into the account file.
- SMTP port `465` fails through a firewall: test port `587` with `SMTP_SECURE=false`; do not set `true` on port `587`.
- Messages use the wrong sender: confirm the Telegram card's account label and ensure `SMTP_FROM` belongs to the same Gmail account. Account routing must never fall back to another mailbox.
