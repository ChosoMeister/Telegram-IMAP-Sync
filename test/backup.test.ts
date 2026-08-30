import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BackupService } from "../src/backup.js";
import { Store } from "../src/store.js";
import { Logger } from "../src/logger.js";
import { config, incoming } from "./helpers.js";

describe("online backup", () => {
  it("keeps a local SQLite backup and sends a compressed copy to a dedicated Telegram chat", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbot-backup-"));
    const store = new Store(join(directory, "live.sqlite"));
    store.upsertMail(incoming);
    store.saveLearnedRule({ accountId: "primary", scope: "sender", senderEmail: "sender@example.com", effect: "not_mine" });
    const telegram = { sendDocumentTo: vi.fn().mockResolvedValue({ message_id: 1 }) };
    const service = new BackupService({ ...config, BACKUP_DIR: directory, BACKUP_RETENTION: 2, BACKUP_TELEGRAM_CHAT_ID: -100123, BACKUP_TELEGRAM_MESSAGE_THREAD_ID: 15, BACKUP_TELEGRAM_MAX_BYTES: 49_000_000 } as any, store, telegram as any, new Logger("error"));
    await service.run();
    const backupName = (await readdir(directory)).find((name) => name.endsWith(".sqlite") && name !== "live.sqlite");
    expect(backupName).toBeTruthy();
    expect(telegram.sendDocumentTo).toHaveBeenCalledWith(-100123, expect.stringMatching(/\.sqlite\.gz$/), expect.any(Buffer), expect.any(String), 15);
    expect(store.getKv("backup:telegram-last-success")).toBeTruthy();
    store.close();
    const restored = new Store(join(directory, backupName!));
    expect(restored.listLearnedRules()).toHaveLength(1);
    restored.close();
    await rm(directory, { recursive: true, force: true });
  });
});
