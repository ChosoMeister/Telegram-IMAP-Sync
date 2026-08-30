import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
import { SpeechToTextService } from "./stt.js";
import { BackupService } from "./backup.js";
import { SafeScheduler } from "./scheduler.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.LOG_LEVEL);
  await mkdir(dirname(config.DATABASE_PATH), { recursive: true });
  const accountConfigs = await loadMailAccountConfigs(config);
  const primaryConfig = accountConfigs[0]!;
  const store = new Store(config.DATABASE_PATH, primaryConfig.id, primaryConfig.label);
  const runtimes = accountConfigs.map((account) => ({ ...account, imap: new ImapService(account.config, logger, account.id, account.label), smtp: new SmtpService(account.config) }));
  const primary = runtimes[0]!;
  const imap = primary.imap;
  const smtp = primary.smtp;
  const telegram = new TelegramApi(config);
  const ai = new AiService(config, logger, await loadHonorifics(config.HONORIFICS_PATH), await loadUserProfile(config.USER_PROFILE_PATH));
  const stt = new SpeechToTextService(config, logger);
  const rules = await MailRuleService.load(config.MAIL_RULES_PATH);
  const app = new MailBotApp(primary.config, store, imap, smtp, telegram, ai, logger, rules, runtimes.slice(1), stt);

  const backup = new BackupService(config, store, telegram, logger);
  const scheduler = new SafeScheduler(logger);

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
    scheduler.stop();
    await app.stop();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info("Starting Telegram IMAP Sync", {
    mode: config.APP_MODE, aiOrder: config.aiProviderOrder, voiceReply: config.VOICE_REPLY_ENABLED,
    sttModels: config.VOICE_REPLY_ENABLED ? config.sttModelOrder : [], mailRules: rules.count, accounts: runtimes.map((account) => account.id)
  });
  await app.start();
  await backup.run();
  scheduler.every("online-backup", config.BACKUP_INTERVAL_HOURS * 3_600_000, () => backup.run());
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "fatal", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
