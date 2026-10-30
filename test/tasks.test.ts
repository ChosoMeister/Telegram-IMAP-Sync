import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { incoming } from "./helpers.js";

describe("durable mail tasks", () => {
  it("leases an overdue reminder once and records delivery separately from task completion", () => {
    const store = new Store(":memory:");
    const { id: mailId } = store.upsertMail(incoming);
    const task = store.createMailTask({ accountId: "primary", title: "پاسخ به ایمیل", state: "open", mailIds: [mailId],
      dueAt: Date.now() - 1000, timezone: "Asia/Tehran", dedupeKey: "test-reminder" });
    const leased = store.leaseDueReminder(60_000);
    expect(leased).toMatchObject({ id: task.id, reminderState: "running", attempts: 1 });
    expect(store.leaseDueReminder()).toBeUndefined();
    store.completeReminder(task.id, 500);
    expect(store.getMailTask(task.id)).toMatchObject({ state: "open", reminderState: "delivered", telegramMessageId: 500 });
    store.close();
  });

  it("deduplicates the same active task but allows it to remain open after mail state changes", () => {
    const store = new Store(":memory:");
    const { id: mailId } = store.upsertMail(incoming);
    const first = store.createMailTask({ accountId: "primary", title: "پیگیری", state: "waiting", mailIds: [mailId], timezone: "Asia/Tehran", dedupeKey: "same" });
    const duplicate = store.createMailTask({ accountId: "primary", title: "پیگیری", state: "waiting", mailIds: [mailId], timezone: "Asia/Tehran", dedupeKey: "same" });
    store.setState(mailId, "done");
    expect(duplicate.id).toBe(first.id);
    expect(store.getMailTask(first.id)?.state).toBe("waiting");
    store.close();
  });

  it("recovers an overdue reminder after a process restart without changing its destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbot-task-restart-"));
    const path = join(directory, "mailbot.sqlite");
    const before = new Store(path);
    const { id: mailId } = before.upsertMail({ ...incoming, accountId: "axon", accountLabel: "Axon" });
    const task = before.createMailTask({ accountId: "axon", title: "پیگیری اکسون", state: "open", mailIds: [mailId],
      dueAt: Date.now() - 1000, timezone: "Asia/Tehran", dedupeKey: "restart-reminder" });
    before.close();

    const after = new Store(path);
    expect(after.leaseDueReminder()).toMatchObject({ id: task.id, accountId: "axon", mailIds: [mailId], reminderState: "running" });
    expect(after.leaseDueReminder()).toBeUndefined();
    after.close();
    await rm(directory, { recursive: true, force: true });
  });
});
