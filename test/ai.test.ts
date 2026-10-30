import { describe, expect, it, vi } from "vitest";
import { AiService, normalizePersianStyle, normalizeReplyHonorific } from "../src/ai.js";
import { Logger } from "../src/logger.js";
import { config, incoming } from "./helpers.js";
import { normalizeSelfReference, type UserProfile } from "../src/user-profile.js";

const profile: UserProfile = {
  displayNameFa: "کاربر نمونه", displayNameEn: "Example User", nameAliases: ["کاربر نمونه", "Example User"],
  identities: [{ email: "user@example.com", organization: "Example" }]
};

describe("AI analysis normalization", () => {
  it("enforces the configured Persian administrative wording deterministically", () => {
    expect(normalizePersianStyle("با سلام و احترام،\nمتشکرم.\nبا تشکر")).toBe("با درود و مهر،\nسپاسگزارم.\nبا سپاس");
    expect(normalizePersianStyle("كار شما تاييد شد")).toBe("کار شما تایید شد");
  });
  it("removes guessed gender and applies only a verified honorific", () => {
    expect(normalizeReplyHonorific("سرکار خانم ناصر طبسی،\nبا درود و مهر")).toBe("ناصر طبسی،\nبا درود و مهر");
    expect(normalizeReplyHonorific("جناب آقای صبا ساده،\nبا درود و مهر", "خانم")).toBe("سرکار خانم صبا ساده،\nبا درود و مهر");
  });
  it("turns third-person references to the profile owner into direct instructions", () => {
    expect(normalizeSelfReference("کاربر نمونه موارد را بررسی کند.", profile)).toEqual({ text: "شما موارد را بررسی کنید.", refersToSelf: true });
  });
  it("accepts a null optional deadline from an OpenAI-compatible provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        importance: "normal", score: 50, summaryFa: "خلاصه", suggestedAction: "کاربر نمونه موارد را بررسی کند", actionOwner: "self", deadline: null, reason: "عادی"
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "test"
    }, new Logger("error"), {}, profile);
    const analysis = await service.analyze({
      ...incoming, id: 1, state: "pending", telegramMessageIds: []
    });
    expect(analysis).toMatchObject({ score: 50, provider: "proxy:test" });
    expect(analysis).toMatchObject({ actionOwner: "self", suggestedAction: "شما موارد را بررسی کنید" });
    expect(analysis).not.toHaveProperty("deadline");
    fetchMock.mockRestore();
  });
  it("drops malformed or oversized action links without discarding an otherwise valid analysis", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        importance: "high", score: 80, summaryFa: "خلاصه", suggestedAction: "بررسی کنید", reason: "درخواست", actionOwner: "self",
        actionLinks: [`https://example.test/${"x".repeat(400)}`, "not-a-url", "https://example.test/valid"]
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "test"
    }, new Logger("error"));
    const analysis = await service.analyze({
      ...incoming, text: "Open https://example.test/valid", id: 1, state: "pending", telegramMessageIds: []
    });
    expect(analysis).toMatchObject({ provider: "proxy:test", actionLinks: ["https://example.test/valid"] });
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
  it("falls back to the next model on the same proxy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        importance: "normal", score: 50, summaryFa: "خلاصه", suggestedAction: "بررسی کنید", reason: "عادی", actionOwner: "self"
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "primary",
      AI_PROXY_MODEL_ORDER: "primary,fallback", aiProxyModelOrder: ["primary", "fallback"]
    }, new Logger("error"));
    const analysis = await service.analyze({ ...incoming, id: 1, state: "pending", telegramMessageIds: [] });
    expect(analysis?.provider).toBe("proxy:fallback");
    const models = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).model);
    expect(models).toEqual(["primary", "fallback"]);
    fetchMock.mockRestore();
  });
  it("validates a structured conversational plan from the configured AI provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ summaryFa: "ساخت پاسخ", needsClarification: false, actions: [
        { kind: "draft_reply", target: "this_mail", instruction: "نسخه اصلاح‌شده را درخواست کن", tone: "formal", replyAll: false }
      ] }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "test"
    }, new Logger("error"));
    const plan = await service.planConversationRequest(
      { ...incoming, id: 1, state: "pending", telegramMessageIds: [] },
      "بهش بگو نسخه اصلاح‌شده رو بفرسته", 1
    );
    expect(plan).toMatchObject({ needsClarification: false, actions: [{ kind: "draft_reply", target: "this_mail" }] });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content).toContain("Never output database IDs");
    fetchMock.mockRestore();
  });
  it("adjudicates Persian-English ASR candidates without transliterating supported English terms", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        finalTranscript: "به ایشان بگو Unsubscribe را انجام دهد", confidence: 0.93, uncertainTerms: [], rationale: "Whisper واژه انگلیسی را واضح ثبت کرده است."
      }) } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "test"
    }, new Logger("error"));
    const result = await service.reconcileVoiceTranscript(
      { ...incoming, id: 1, state: "pending", telegramMessageIds: [] },
      [{ model: "qwen", text: "بهش بگو آن سابسکرایب را انجام بده" }, { model: "whisper", text: "بهش بگو Unsubscribe را انجام بده" }]
    );
    expect(result).toMatchObject({ finalTranscript: "به ایشان بگو Unsubscribe را انجام دهد", confidence: 0.93, provider: "proxy:test" });
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content).toContain("Preserve English words in Latin script");
    expect(request.messages[0].content).toContain("Never add an action");
    fetchMock.mockRestore();
  });
  it("uses the transcript-specific fast model order without changing the regular AI order", async () => {
    const models: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        finalTranscript: "از این پس اکانتشان را تمدید کنند", confidence: 0.9, uncertainTerms: [], rationale: "تطبیق آوایی"
      }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const service = new AiService({
      ...config, AI_ENABLED: true, AI_PROVIDER_ORDER: "proxy", aiProviderOrder: ["proxy"],
      AI_PROXY_BASE_URL: "https://ai.example.test/v1", AI_PROXY_API_KEY: "test", AI_PROXY_MODEL: "quality",
      AI_PROXY_MODEL_ORDER: "quality,fast", aiProxyModelOrder: ["quality", "fast"],
      AI_TRANSCRIPT_MODEL_ORDER: "fast,quality", aiTranscriptModelOrder: ["fast", "quality"]
    }, new Logger("error"));
    await service.reconcileVoiceTranscript({ ...incoming, id: 1, state: "pending", telegramMessageIds: [] }, [
      { model: "qwen", text: "زینپس کنتشون" }, { model: "whisper", text: "زیمپس کنتشون" }
    ]);
    expect(models).toEqual(["fast"]);
    fetchMock.mockRestore();
  });
});
