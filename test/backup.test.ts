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
    const telegram = { sendDocumentTo: vi.fn().mockResolvedValue({ message_id: 1 }) };
    const service = new BackupService({ ...config, BACKUP_DIR: directory, BACKUP_RETENTION: 2, BACKUP_TELEGRAM_CHAT_ID: -100123, BACKUP_TELEGRAM_MAX_BYTES: 49_000_000 } as any, store, telegram as any, new Logger("error"));
    await service.run();
    expect((await readdir(directory)).some((name) => name.endsWith(".sqlite") && name !== "live.sqlite")).toBe(true);
    expect(telegram.sendDocumentTo).toHaveBeenCalledWith(-100123, expect.stringMatching(/\.sqlite\.gz$/), expect.any(Buffer), expect.any(String));
    expect(store.getKv("backup:telegram-last-success")).toBeTruthy();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});
