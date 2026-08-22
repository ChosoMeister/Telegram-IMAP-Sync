import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechToTextService } from "../src/stt.js";
import { Logger } from "../src/logger.js";
import { config } from "./helpers.js";
import { loadConfig } from "../src/config.js";

afterEach(() => vi.unstubAllGlobals());

describe("SpeechToTextService", () => {
  it("fails fast when Voice is enabled without complete STT credentials", () => {
    expect(() => loadConfig({
      TELEGRAM_BOT_TOKEN: "1234567890:test", TELEGRAM_USER_ID: "42", VOICE_REPLY_ENABLED: "true",
      STT_BASE_URL: "https://stt.example/v1"
    })).toThrow("requires STT_BASE_URL and STT_API_KEY");
  });

  it("falls back to the next model and returns a trimmed transcript", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const model = (init?.body as FormData).get("model") as string;
      requests.push(model);
      return model === "qwen"
        ? new Response('{"error":"temporary"}', { status: 503 })
        : new Response('{"text":"  متن صحیح فارسی  "}', { status: 200 });
    }));
    const service = new SpeechToTextService({
      ...config, VOICE_REPLY_ENABLED: true, STT_BASE_URL: "https://stt.example/v1", STT_API_KEY: "secret",
      STT_MODEL_ORDER: "qwen,whisper", sttModelOrder: ["qwen", "whisper"]
    }, new Logger("error"));
    await expect(service.transcribe(Buffer.from("audio"), "voice.ogg")).resolves.toBe("متن صحیح فارسی");
    expect(requests).toEqual(["qwen", "whisper"]);
    expect(service.status()).toMatchObject({ ok: true, model: "whisper" });
  });

  it("rejects audio beyond the configured limit before calling the proxy", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = new SpeechToTextService({
      ...config, VOICE_REPLY_ENABLED: true, VOICE_MAX_BYTES: 4, STT_BASE_URL: "https://stt.example/v1", STT_API_KEY: "secret",
      STT_MODEL_ORDER: "qwen", sttModelOrder: ["qwen"]
    }, new Logger("error"));
    await expect(service.transcribe(Buffer.from("audio"))).rejects.toThrow("outside the configured limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
