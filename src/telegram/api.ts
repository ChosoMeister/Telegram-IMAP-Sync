import type { AppConfig } from "../config.js";

export interface TelegramMessage { message_id: number; text?: string; from?: { id: number }; chat: { id: number }; }
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; from: { id: number }; data?: string; message?: TelegramMessage };
}

type Button = { text: string; callback_data?: string; style?: "danger" | "success" | "primary" };

export class TelegramApi {
  private readonly base: string;
  constructor(private readonly config: AppConfig) { this.base = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}`; }

  private async call<T>(method: string, body: Record<string, unknown>, retrySafe = true): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const response = await fetch(`${this.base}/${method}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(40_000)
        });
        const json = await response.json() as { ok: boolean; result: T; description?: string; parameters?: { retry_after?: number } };
        if (json.ok) return json.result;
        const retryAfter = json.parameters?.retry_after;
        const retryable = response.status === 429 || (retrySafe && response.status >= 500);
        if (!retryable || attempt === 3) throw new Error(`Telegram ${method}: ${json.description ?? response.status}`);
        await this.delay((retryAfter ? retryAfter * 1000 : 500 * (2 ** attempt)) + Math.floor(Math.random() * 250));
      } catch (error) {
        lastError = error;
        if (!retrySafe || attempt === 3 || (error instanceof Error && error.message.startsWith("Telegram "))) throw error;
        await this.delay(500 * (2 ** attempt) + Math.floor(Math.random() * 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Telegram ${method} failed`);
  }

  private delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

  getMe(): Promise<{ id: number; username?: string; is_bot: boolean }> { return this.call("getMe", {}); }
  getChat(): Promise<{ id: number; type: string }> { return this.call("getChat", { chat_id: this.config.TELEGRAM_USER_ID }); }
  getWebhookInfo(): Promise<{ url: string; pending_update_count: number }> { return this.call("getWebhookInfo", {}); }

  sendMessage(text: string, buttons?: Button[][], silent = false, forceReply = false): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      chat_id: this.config.TELEGRAM_USER_ID, text, disable_notification: silent,
      parse_mode: "HTML", link_preview_options: { is_disabled: true },
      ...(forceReply ? { reply_markup: { force_reply: true, selective: true } } : buttons ? { reply_markup: { inline_keyboard: buttons } } : {})
    }, false);
  }

  async editMessage(messageId: number, text: string, buttons?: Button[][]): Promise<TelegramMessage | boolean> {
    try {
      return await this.call("editMessageText", {
        chat_id: this.config.TELEGRAM_USER_ID, message_id: messageId, text,
        parse_mode: "HTML", link_preview_options: { is_disabled: true },
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {})
      });
    } catch (error) {
      // Telegram returns 400 when the card is already in the requested state.
      // For navigation/normalization this is an idempotent success, not a failure.
      if (error instanceof Error && error.message.includes("message is not modified")) return true;
      throw error;
    }
  }

  async sendDocument(filename: string, content: Buffer, caption?: string): Promise<TelegramMessage> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const form = new FormData();
      form.set("chat_id", String(this.config.TELEGRAM_USER_ID));
      if (caption) form.set("caption", caption);
      form.set("document", new Blob([new Uint8Array(content)]), filename);
      const response = await fetch(`${this.base}/sendDocument`, {
        method: "POST", body: form, signal: AbortSignal.timeout(120_000)
      });
      const json = await response.json() as {
        ok: boolean; result: TelegramMessage; description?: string; parameters?: { retry_after?: number }
      };
      if (json.ok) return json.result;
      if (response.status !== 429 || attempt === 3) throw new Error(`Telegram sendDocument: ${json.description ?? response.status}`);
      await this.delay(((json.parameters?.retry_after ?? 1) * 1000) + Math.floor(Math.random() * 250));
    }
    throw new Error("Telegram sendDocument failed");
  }

  deleteMessages(ids: number[]): Promise<boolean> {
    if (!ids.length) return Promise.resolve(true);
    return this.call("deleteMessages", { chat_id: this.config.TELEGRAM_USER_ID, message_ids: ids.slice(0, 100) });
  }
  answerCallbackQuery(id: string, text?: string): Promise<boolean> { return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }); }
  getUpdates(offset: number, timeout = 30): Promise<TelegramUpdate[]> { return this.call("getUpdates", { offset, timeout, allowed_updates: ["message", "callback_query"] }); }
}

export function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
