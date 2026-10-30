import { AiService } from "./ai.js";
import { loadConfig } from "./config.js";
import type { StoredMail } from "./domain/types.js";
import { Logger } from "./logger.js";
import type { UserProfile } from "./user-profile.js";

const config = loadConfig();
const profile: UserProfile = {
  displayNameFa: "کاربر آزمایشی", nameAliases: ["کاربر آزمایشی"],
  identities: [{ email: "owner@example.invalid", organization: "Example" }],
  workingSchedule: { workingDays: ["saturday", "sunday", "monday", "tuesday", "wednesday"], startTime: "10:00", endTime: "18:00" }
};
const ai = new AiService(config, new Logger("warn"), {}, profile);
const base: StoredMail = {
  id: 1, accountId: "verification", accountLabel: "Verification", uid: 1, uidValidity: "synthetic", mailbox: "INBOX",
  messageId: "<synthetic-verification@example.invalid>", references: [], subject: "Synthetic verification mail",
  from: [{ name: "Verification Sender", address: "sender@example.invalid" }],
  to: [{ address: "owner@example.invalid" }], cc: [], replyTo: [], receivedAt: new Date(),
  text: "This is synthetic test data. Please send the corrected invoice by tomorrow.", attachments: [],
  state: "pending", telegramMessageIds: []
};

const direct = await ai.planConversationRequest(base, "این رو آرشیو کن", 1);
const automation = await ai.planConversationRequest(base, "خبرنامه‌های تبلیغاتی بدون اقدام رو خودکار آرشیو کن؛ اخطار انقضا استثناست", 1);
const reminder = await ai.planConversationRequest(base, "شنبه اول صبح یادآوری کن جوابش رو بدم", 1);
const analysis = await ai.analyze({ ...base, subject: "هشدار انقضای SSL", text: "گواهی SSL فردا منقضی می‌شود و سرویس ممکن است قطع شود." });
const otherOwner = await ai.analyze({ ...base, to: [{ address: "admin@example.invalid" }], cc: [{ address: "owner@example.invalid" }],
  subject: "هماهنگی ادمین و مالی", text: "تیم ادمین و مالی لطفاً این مورد را بررسی کنند." });
const explicitOwner = await ai.analyze({ ...base, to: [{ address: "admin@example.invalid" }], cc: [{ address: "owner@example.invalid" }],
  subject: "هماهنگی ادمین و مالی", text: "کاربر آزمایشی لطفاً این مورد را بررسی و نتیجه را اعلام کند." });

if (!direct.actions.some((action) => action.kind === "archive")) throw new Error("Real model did not produce the bounded archive action");
if (!automation.actions.some((action) => action.kind === "set_automation")) throw new Error("Real model did not produce a bounded automation policy");
if (!reminder.actions.some((action) => action.kind === "create_task" && action.needsReminder && action.dueAt)) throw new Error("Real model did not resolve the configured first working morning");
if (!analysis || !["critical", "high"].includes(analysis.importance) || !analysis.riskFa) {
  throw new Error("Real model did not preserve importance and risk for the synthetic SSL alert");
}
if (!otherOwner || otherOwner.actionOwner === "self" || !explicitOwner || !["self", "shared"].includes(explicitOwner.actionOwner ?? "unknown")) {
  throw new Error("Real model did not distinguish CC context from an explicit owner request");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  plannerProviderHealth: ai.status(),
  directActions: direct.actions.map((action) => action.kind),
  automationActions: automation.actions.map((action) => action.kind),
  reminderActions: reminder.actions.map((action) => action.kind),
  sslAlert: { provider: analysis.provider, importance: analysis.importance, score: analysis.score, actionOwner: analysis.actionOwner, hasRisk: Boolean(analysis.riskFa) },
  ownership: { ccOnly: otherOwner.actionOwner, explicitRequest: explicitOwner.actionOwner }
})}\n`);
