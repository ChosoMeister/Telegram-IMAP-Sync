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

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger(config.LOG_LEVEL);
  await mkdir(dirname(config.DATABASE_PATH), { recursive: true });
  const store = new Store(config.DATABASE_PATH);
  const imap = new ImapService(config, logger);
  const smtp = new SmtpService(config);
  const telegram = new TelegramApi(config);
  const ai = new AiService(config, logger);
  const app = new MailBotApp(config, store, imap, smtp, telegram, ai, logger);

  const health = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, mode: config.APP_MODE, time: new Date().toISOString() }));
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

  logger.info("Starting Telegram IMAP Sync", { mode: config.APP_MODE, aiOrder: config.aiProviderOrder });
  await app.start();
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "fatal", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
