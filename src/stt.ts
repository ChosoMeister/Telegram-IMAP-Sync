import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

type TranscriptionResponse = { text?: unknown };

export class SpeechToTextService {
  private health: { ok?: boolean; model?: string; lastSuccess?: string; lastError?: string } = {};

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {}

  status(): Record<string, unknown> {
    return { enabled: this.config.VOICE_REPLY_ENABLED, models: this.config.sttModelOrder, ...this.health };
  }

  async transcribe(content: Buffer, filename = "voice.ogg"): Promise<string> {
    if (!this.config.VOICE_REPLY_ENABLED) throw new Error("Voice reply is disabled");
    if (!this.config.STT_BASE_URL || !this.config.STT_API_KEY || !this.config.sttModelOrder.length) {
      throw new Error("Speech-to-text is not configured");
    }
    if (!content.length || content.length > this.config.VOICE_MAX_BYTES) throw new Error("Voice file size is outside the configured limit");

    let lastError: unknown;
    for (const model of this.config.sttModelOrder) {
      try {
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(content)]), filename);
        form.set("model", model);
        form.set("language", this.config.STT_LANGUAGE);
        form.set("response_format", "json");
        const response = await fetch(`${this.config.STT_BASE_URL.replace(/\/$/, "")}/audio/transcriptions`, {
          method: "POST",
          headers: { authorization: `Bearer ${this.config.STT_API_KEY}` },
          body: form,
          signal: AbortSignal.timeout(this.config.STT_TIMEOUT_MS)
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`STT HTTP ${response.status}`);
        let json: TranscriptionResponse;
        try { json = JSON.parse(raw) as TranscriptionResponse; }
        catch { throw new Error("STT returned invalid JSON"); }
        const text = typeof json.text === "string" ? json.text.trim() : "";
        if (!text) throw new Error("STT returned an empty transcript");
        this.health = { ok: true, model, lastSuccess: new Date().toISOString() };
        return text;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        this.health = { ok: false, model, lastError: message };
        this.logger.warn("Speech-to-text model failed; trying fallback", { model, error: message });
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Every speech-to-text model failed");
  }
}
