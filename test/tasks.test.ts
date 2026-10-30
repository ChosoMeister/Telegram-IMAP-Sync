import { describe, expect, it } from "vitest";
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
});
