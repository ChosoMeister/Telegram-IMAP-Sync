import { z } from "zod";

const targetSchema = z.enum(["this_mail", "snapshot"]);
const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ask"), target: targetSchema, question: z.string().trim().min(1).max(1000) }),
  z.object({ kind: z.literal("archive"), target: targetSchema }),
  z.object({ kind: z.literal("draft_reply"), target: targetSchema, instruction: z.string().trim().min(1).max(1500),
    tone: z.enum(["formal", "short", "friendly"]).default("formal"), replyAll: z.boolean().default(false) }),
  z.object({ kind: z.literal("draft_forward"), target: targetSchema, instruction: z.string().trim().max(1500).default("") }),
  z.object({ kind: z.literal("remember"), target: targetSchema,
    memoryKind: z.enum(["preference", "role", "correction", "pattern", "exception", "permission"]),
    key: z.string().trim().min(1).max(120), statement: z.string().trim().min(1).max(1000),
    scope: z.enum(["global", "account"]) }),
  z.object({ kind: z.literal("cancel"), target: targetSchema })
]);

export const conversationPlanSchema = z.object({
  summaryFa: z.string().trim().min(1).max(300),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().trim().min(1).max(300).optional(),
  actions: z.array(actionSchema).max(4)
}).superRefine((plan, context) => {
  if (plan.needsClarification && !plan.clarificationQuestion) {
    context.addIssue({ code: "custom", path: ["clarificationQuestion"], message: "Clarification question is required" });
  }
  if (!plan.needsClarification && plan.actions.length === 0) {
    context.addIssue({ code: "custom", path: ["actions"], message: "At least one action is required" });
  }
});

export type ConversationPlan = z.infer<typeof conversationPlanSchema>;
export type ConversationPlanAction = ConversationPlan["actions"][number];
export const parseConversationPlan = (value: unknown): ConversationPlan => conversationPlanSchema.parse(value);
