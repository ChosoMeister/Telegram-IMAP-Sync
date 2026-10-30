# Conversational assistant acceptance evidence

This matrix maps the 21 mission scenarios to repeatable executable evidence. Unit/integration tests use synthetic mail and mocked transports; the real-model verifier uses synthetic content and calls only the configured AI provider. It never opens Telegram, IMAP, SMTP, or SQLite.

| # | Scenario | Repeatable evidence |
|---|---|---|
| 1 | Free text without Reply is answered | `workflow.test.ts` — free-message/local-search test |
| 2 | Direct Reply targets the exact card | direct Reply immutable-reference workflow test |
| 3 | Fast commands for two accounts remain isolated | durable command leasing, independent drafts, and account-routing tests |
| 4 | Old card snapshot excludes a later thread reply | old-card snapshot workflow test |
| 5 | Newsletter history does not downgrade an SSL alert | automation exception/critical guards, learned-rule regression, and real-model SSL check |
| 6 | CC-only ownership differs from an explicit owner request | `npm run verify:ai` asserts `other` versus `self/shared` |
| 7 | Important FYI keeps importance/risk when archived | critical informational direct-archive assertion and informational-rule tests |
| 8 | Authorized receipt differs from a new payment request | automation receipt/payment-request test |
| 9 | Three selected mails change; similar outside mail does not | exact three-mail snapshot workflow test |
| 10 | Repeated archive is idempotent and IMAP identity is stable | repeated Done, action-lock, and account/UIDVALIDITY/UID tests |
| 11 | Colloquial request becomes a draft; stale approval cannot send a changed draft | natural draft and version-bound approval tests |
| 12 | Ambiguous SMTP outcome cannot resend blindly | SMTP crash-stage, Sent/Archive recovery, and durable outbound tests |
| 13 | Work schedule and corrections survive restart | validated profile schedule and persistent-memory restart tests |
| 14 | Learning generalizes while exceptions remain active | account/rule matching and automation exception tests |
| 15 | A correction supersedes the old interpretation | memory superseding and explicit revert tests |
| 16 | Reminder survives restart/downtime and keeps destination | task restart lease and reminder delivery-deduplication tests |
| 17 | Archive/reply does not close an independent task | task remains open after source-mail state changes |
| 18 | AI/Telegram/IMAP failure cannot lose a command or claim false success | durable command, terminal AI, Telegram cleanup, and IMAP reconnect tests |
| 19 | Buttons, attachments, Reply All, Forward, and RSVP regressions | workflow, reply, content, render, and extraction suites |
| 20 | Migration preserves mail/card identity without republishing | production-like migration fixture and idempotent card-reference backfill |
| 21 | Stopping automation prevents new automatic actions | paused-policy test; analysis and conversation remain independent |

## Commands

```sh
npm ci
npm run check
npm audit --audit-level=low
npm run verify:ai
```

The configured model names must be authorized by the proxy. For the current organizational proxy they are `local-gpt-oss-120b` followed by `local-gemma4-26b`. The verifier exits non-zero unless the real model produces bounded Archive, automation, and reminder plans; preserves SSL importance/risk; and distinguishes CC-only context from an explicit owner request.

Docker-only verification remains a separate host prerequisite: `docker compose build mailbot`. A stopped Docker daemon is an environment failure, not passing container evidence.
