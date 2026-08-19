import { describe, expect, it, vi } from "vitest";
import { AiService, normalizePersianStyle, normalizeReplyHonorific } from "../src/ai.js";
import { Logger } from "../src/logger.js";
import { config, incoming } from "./helpers.js";

describe("AI analysis normalization", () => {
  it("enforces the configured Persian administrative wording deterministically", () => {
    expect(normalizePersianStyle("با سلام و احترام،\nمتشکرم.\nبا تشکر")).toBe("با درود و مهر،\nسپاسگزارم.\nبا سپاس");
    expect(normalizePersianStyle("كار شما تاييد شد")).toBe("کار شما تایید شد");
  });
  it("removes guessed gender and applies only a verified honorific", () => {
    expect(normalizeReplyHonorific("سرکار خانم ناصر طبسی،\nبا درود و مهر")).toBe("ناصر طبسی،\nبا درود و مهر");
    expect(normalizeReplyHonorific("جناب آقای صبا ساده،\nبا درود و مهر", "خانم")).toBe("سرکار خانم صبا ساده،\nبا درود و مهر");
  });
  it("accepts a null optional deadline from an OpenAI-compatible provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        importance: "normal", score: 50, summaryFa: "خلاصه", suggestedAction: "بررسی", deadline: null, reason: "عادی"
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "test"
    }, new Logger("error"));
    const analysis = await service.analyze({
      ...incoming, id: 1, state: "pending", telegramMessageIds: []
    });
    expect(analysis).toMatchObject({ score: 50, provider: "proxy" });
    expect(analysis).not.toHaveProperty("deadline");
    fetchMock.mockRestore();
  });
  it("normalizes a model reply even when the provider ignores the Persian style policy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ text: "با سلام و احترام\nدرخواست دریافت شد.\nبا تشکر" }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "test"
    }, new Logger("error"));
    const reply = await service.draftReply({ ...incoming, id: 1, state: "pending", telegramMessageIds: [] }, "", "formal", false);
    expect(reply).toBe("با درود و مهر\nدرخواست دریافت شد.\nبا سپاس");
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content).toContain("با درود و مهر");
    expect(request.messages[0].content).toContain("با سپاس");
    fetchMock.mockRestore();
  });
});
