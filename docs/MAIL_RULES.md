# Local mail rules

Rules optionally route matching Inbox mail on Exchange before Telegram delivery. They are first-match-wins and are applied in file order. Writes occur only in `APP_MODE=live`.

Create an untracked `config/mail-rules.json` and set:

```env
MAIL_RULES_PATH=/app/config/mail-rules.json
```

Example:

```json
[
  {
    "name": "Invoices",
    "match": {
      "fromAny": ["billing@example.com", "*@supplier.example"],
      "toAny": ["finance@example.com"],
      "containsAny": ["invoice", "صورتحساب"]
    },
    "actions": {
      "copyTo": "Finance",
      "markRead": false,
      "flagged": true
    }
  }
]
```

Match fields are optional and combined with AND. Values within one array use OR:

- `fromAny`, `toAny`, `ccAny`: case-insensitive address patterns; `*` wildcards are supported. A plain substring also matches an address.
- `containsAny`: case-insensitive search across subject, normalized text, and filenames classified as real attachments. Signature/inline image names do not trigger rules.

At least one action is required:

- `moveTo`: move to an existing mailbox. The message then does not become a pending Telegram Inbox card.
- `copyTo`: copy while retaining the source in Inbox.
- `markRead`: set or clear read state.
- `flagged`: set or clear the flag.

Run mailbox discovery first. Every `moveTo`/`copyTo` destination must exist and use the exact server path. Rules may contain business-sensitive addresses and folder names, so the real file is ignored by Git; commit only sanitized examples.
