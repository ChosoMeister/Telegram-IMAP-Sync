# Conversational Email Assistant

## Goal

Incrementally add durable Persian conversation, memory, tasks, reminders, and opt-in automation to the existing mail engine without replacing its IMAP/SMTP/Telegram reliability model.

## Tasks

- [x] Stabilize the production baseline: AI parsing, terminal job retries, Telegram backup staging, dependency audit, and public fixtures.
- [x] Persist Telegram message references and user commands before advancing update offsets; resolve direct replies to immutable mail snapshots.
- [x] Add a schema-validated conversational planner whose read/write tools reuse the existing archive, reply, forward, calendar, and recovery services.
  - [x] Add a fail-closed first-stage intent router for Ask, Reply, Reply All, Forward, Cancel, and confirmation-gated Archive.
  - [x] Add validated multi-step plans, clarification, and durable tool-result history.
- [ ] Add structured memory, explicit permissions, exceptions, explanations, and superseding corrections in SQLite.
  - [x] Persist sourced, scoped confirmed/inferred memories; apply only confirmed active memories to analysis; support superseding corrections and `/memory` disable/restore.
  - [x] Keep informational/action ownership independent from importance, score, risk, and notification urgency.
  - [ ] Add automation permission/exception evaluation and natural-language decision explanations.
- [ ] Add independent mail tasks and durable Tehran-time reminders with restart/downtime recovery.
- [ ] Add observation-only automation, then gated execution for new mail after explicit production approval.
- [ ] Run migration/regression/real-model tests, update all documentation, and prepare backup, deployment, and rollback instructions.

## Done when

- [ ] All 21 acceptance scenarios in the mission have repeatable evidence and production activation remains separately gated.
