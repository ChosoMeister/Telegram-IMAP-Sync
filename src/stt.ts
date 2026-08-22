import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

type TranscriptionResponse = { text?: unknown };

export interface AsrCandidate {
  model: string;
  text: string;
}

export interface ParallelTranscription {
  candidates: AsrCandidate[];
  failedModels: Array<{ model: string; error: string }>;
}

export class SpeechToTextService {
  private health: { ok?: boolean; models?: string[]; failedModels?: string[]; lastSuccess?: string; lastError?: string } = {};

  constructor(private readonly config: AppConfig, private readonly logger: Logger) {}

  status(): Record<string, unknown> {
    return { enabled: this.config.VOICE_REPLY_ENABLED, configuredModels: this.config.sttModelOrder, ...this.health };
  }

  async transcribe(content: Buffer, filename = "voice.ogg"): Promise<ParallelTranscription> {
    if (!this.config.VOICE_REPLY_ENABLED) throw new Error("Voice reply is disabled");
    if (!this.config.STT_BASE_URL || !this.config.STT_API_KEY || !this.config.sttModelOrder.length) {
      throw new Error("Speech-to-text is not configured");
    }
    if (!content.length || content.length > this.config.VOICE_MAX_BYTES) throw new Error("Voice file size is outside the configured limit");

    const settled = await Promise.all(this.config.sttModelOrder.map(async (model) => {
      try {
        return { ok: true as const, candidate: await this.transcribeModel(model, content, filename) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn("Speech-to-text model failed during parallel transcription", { model, error: message });
        return { ok: false as const, failure: { model, error: message } };
      }
    }));
    const candidates = settled.flatMap((item) => item.ok ? [item.candidate] : []);
    const failedModels = settled.flatMap((item) => item.ok ? [] : [item.failure]);
    if (!candidates.length) {
      const reason = failedModels.map((item) => `${item.model}: ${item.error}`).join("; ") || "Every speech-to-text model failed";
      this.health = { ok: false, models: [], failedModels: failedModels.map((item) => item.model), lastError: reason };
      throw new Error(reason);
    }
    this.health = { ok: true, models: candidates.map((item) => item.model), failedModels: failedModels.map((item) => item.model), lastSuccess: new Date().toISOString() };
    return { candidates, failedModels };
  }

  private async transcribeModel(model: string, content: Buffer, filename: string): Promise<AsrCandidate> {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(content)]), filename);
    form.set("model", model);
    if (this.config.STT_LANGUAGE.toLowerCase() !== "auto") form.set("language", this.config.STT_LANGUAGE);
    form.set("response_format", "json");
    const response = await fetch(`${this.config.STT_BASE_URL!.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST", headers: { authorization: `Bearer ${this.config.STT_API_KEY}` }, body: form,
      signal: AbortSignal.timeout(this.config.STT_TIMEOUT_MS)
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`STT HTTP ${response.status}`);
    let json: TranscriptionResponse;
    try { json = JSON.parse(raw) as TranscriptionResponse; }
    catch { throw new Error("STT returned invalid JSON"); }
    const text = typeof json.text === "string" ? json.text.trim() : "";
    if (!text) throw new Error("STT returned an empty transcript");
    return { model, text };
  }
}
