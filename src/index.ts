import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { Store } from "./store.js";
import { AiService } from "./ai.js";
import { ImapService } from "./mail/imap.js";
import { SmtpService } from "./mail/smtp.js";
import { TelegramApi } from "./telegram/api.js";
import { MailBotApp } from "./app.js";
import { MailRuleService } from "./rules.js";
import { loadHonorifics } from "./honorifics.js";
import { loadUserProfile } from "./user-profile.js";
import { loadMailAccountConfigs } from "./accounts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.LOG_LEVEL);
  await mkdir(dirname(config.DATABASE_PATH), { recursive: true });
  const store = new Store(config.DATABASE_PATH, config.PRIMARY_ACCOUNT_ID, config.PRIMARY_ACCOUNT_LABEL);
  const accountConfigs = await loadMailAccountConfigs(config);
  const runtimes = accountConfigs.map((account) => ({ ...account, imap: new ImapService(account.config, logger, account.id, account.label), smtp: new SmtpService(account.config) }));
  const primary = runtimes[0]!;
  const imap = primary.imap;
  const smtp = primary.smtp;
  const telegram = new TelegramApi(config);
  const ai = new AiService(config, logger, await loadHonorifics(config.HONORIFICS_PATH), await loadUserProfile(config.USER_PROFILE_PATH));
  const rules = await MailRuleService.load(config.MAIL_RULES_PATH);
  const app = new MailBotApp(config, store, imap, smtp, telegram, ai, logger, rules, runtimes.slice(1));

  const runBackup = async () => {
    try {
      await mkdir(config.BACKUP_DIR, { recursive: true });
      const filename = `mailbot-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
      await store.backup(join(config.BACKUP_DIR, filename));
      const files = (await readdir(config.BACKUP_DIR)).filter((name) => /^mailbot-.*\.sqlite$/.test(name));
      const ordered = await Promise.all(files.map(async (name) => ({ name, modified: (await stat(join(config.BACKUP_DIR, name))).mtimeMs })));
      for (const old of ordered.sort((a, b) => b.modified - a.modified).slice(config.BACKUP_RETENTION)) {
        await unlink(join(config.BACKUP_DIR, old.name));
      }
      store.setKv("backup:last-success", new Date().toISOString());
      store.deleteKv("backup:last-error");
      logger.info("SQLite online backup completed", { filename, retention: config.BACKUP_RETENTION });
    } catch (error) {
      store.setKv("backup:last-error", error instanceof Error ? error.message : String(error));
      logger.error("SQLite online backup failed", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const health = createServer((_request, response) => {
    const status = app.status();
    const ok = status.ok === true;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...status, mode: config.APP_MODE, time: new Date().toISOString() }));
  });
  health.listen(config.HEALTH_PORT, "0.0.0.0");

  const shutdown = async (signal: string) => {
    logger.info("Shutting down", { signal });
    health.close();
    await app.stop();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Starting Telegram IMAP Sync", { mode: config.APP_MODE, aiOrder: config.aiProviderOrder, mailRules: rules.count, accounts: runtimes.map((account) => account.id) });
  await app.start();
  await runBackup();
  setInterval(() => void runBackup(), config.BACKUP_INTERVAL_HOURS * 3_600_000).unref();
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "fatal", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
