import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { TelegramApi } from "./telegram/api.js";
import { AiService } from "./ai.js";
import type { StoredMail } from "./domain/types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_MODE !== "dry-run") throw new Error("Preflight must run with APP_MODE=dry-run");
  const telegram = new TelegramApi(config);
  const [botResult, chatResult, webhookResult] = await Promise.allSettled([telegram.getMe(), telegram.getChat(), telegram.getWebhookInfo()]);

  let ai: Record<string, unknown> = { enabled: config.AI_ENABLED, ok: false };
  if (config.AI_ENABLED) {
    const sample: StoredMail = {
      id: 0, uid: 0, uidValidity: "preflight", mailbox: "INBOX", state: "pending", telegramMessageIds: [],
      messageId: "<preflight@example.invalid>", references: [], subject: "درخواست بررسی تا فردا",
      from: [{ address: "sender@example.invalid" }], to: [{ address: config.SMTP_FROM }], cc: [], replyTo: [],
      receivedAt: new Date(), text: "این یک پیام ساختگی برای تست اتصال مدل است. لطفاً اهمیت آن را تحلیل کن.", attachments: []
    };
    const analysis = await new AiService(config, new Logger(config.LOG_LEVEL)).analyze(sample);
    ai = analysis ? { enabled: true, ok: true, provider: analysis.provider } : { enabled: true, ok: false };
  }

  process.stdout.write(`${JSON.stringify({
    mode: config.APP_MODE,
    telegram: {
      bot: botResult.status === "fulfilled" ? { ok: true, botId: botResult.value.id, username: botResult.value.username ?? null } : { ok: false, error: String(botResult.reason) },
      chat: chatResult.status === "fulfilled" ? { ok: true, chatIdMatches: chatResult.value.id === config.TELEGRAM_USER_ID, chatType: chatResult.value.type } : { ok: false, error: String(chatResult.reason) },
      webhook: webhookResult.status === "fulfilled" ? { ok: true, configured: Boolean(webhookResult.value.url), pendingUpdates: webhookResult.value.pending_update_count } : { ok: false, error: String(webhookResult.reason) }
    },
    ai
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
