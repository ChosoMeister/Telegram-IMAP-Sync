import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { TelegramApi } from "./telegram/api.js";
import { describeError } from "./errors.js";

export class BackupService {
  constructor(private config: AppConfig, private store: Store, private telegram: TelegramApi, private logger: Logger) {}

  async runIfDue(now = new Date()): Promise<boolean> {
    const lastSuccess = this.store.getKv("backup:last-success");
    const lastSuccessMs = lastSuccess ? Date.parse(lastSuccess) : Number.NaN;
    const intervalMs = this.config.BACKUP_INTERVAL_HOURS * 3_600_000;
    if (Number.isFinite(lastSuccessMs) && now.getTime() - lastSuccessMs < intervalMs) return false;
    await this.run();
    return true;
  }

  async run(): Promise<void> {
    try {
      await mkdir(this.config.BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `mailbot-${stamp}.sqlite`;
      const path = join(this.config.BACKUP_DIR, filename);
      await this.store.backup(path);
      await this.retainNewest();
      this.store.setKv("backup:last-success", new Date().toISOString());
      this.store.deleteKv("backup:last-error");
      this.logger.info("SQLite online backup completed", { filename, retention: this.config.BACKUP_RETENTION });
      if (this.config.BACKUP_TELEGRAM_CHAT_ID !== undefined) await this.sendToTelegram(path, filename);
    } catch (error) {
      const message = describeError(error);
      this.store.setKv("backup:last-error", message);
      this.logger.error("SQLite online backup failed", { error: message });
    }
  }

  private async retainNewest(): Promise<void> {
    const files = (await readdir(this.config.BACKUP_DIR)).filter((name) => /^mailbot-.*\.sqlite$/.test(name));
    const ordered = await Promise.all(files.map(async (name) => ({ name, modified: (await stat(join(this.config.BACKUP_DIR, name))).mtimeMs })));
    for (const old of ordered.sort((a, b) => b.modified - a.modified).slice(this.config.BACKUP_RETENTION)) await unlink(join(this.config.BACKUP_DIR, old.name));
  }

  private async sendToTelegram(path: string, filename: string): Promise<void> {
    const compressedPath = `/tmp/${filename}.gz`;
    try {
      await pipeline(createReadStream(path), createGzip({ level: 9 }), createWriteStream(compressedPath, { flags: "wx" }));
      const compressedSize = (await stat(compressedPath)).size;
      if (compressedSize > this.config.BACKUP_TELEGRAM_MAX_BYTES) {
        throw new Error(`Compressed backup is ${compressedSize} bytes; Telegram limit is configured as ${this.config.BACKUP_TELEGRAM_MAX_BYTES} bytes`);
      }
      const { readFile } = await import("node:fs/promises");
      await this.telegram.sendDocumentTo(
        this.config.BACKUP_TELEGRAM_CHAT_ID!, `${filename}.gz`, await readFile(compressedPath),
        "نسخه پشتیبان MailBot", this.config.BACKUP_TELEGRAM_MESSAGE_THREAD_ID
      );
      this.store.setKv("backup:telegram-last-success", new Date().toISOString());
      this.store.deleteKv("backup:telegram-last-error");
      this.logger.info("Compressed backup sent to Telegram", { filename: `${filename}.gz`, compressedSize });
    } catch (error) {
      const message = describeError(error);
      this.store.setKv("backup:telegram-last-error", message);
      this.logger.warn("Telegram backup delivery failed; local backup remains valid", { error: message });
    } finally { await unlink(compressedPath).catch(() => undefined); }
  }
}
