import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/ai.js";
import { Logger } from "../src/logger.js";
import { config, incoming } from "./helpers.js";

describe("AI analysis normalization", () => {
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
});
