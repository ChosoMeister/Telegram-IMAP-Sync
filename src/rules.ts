import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { IncomingMail } from "./domain/types.js";

const ruleSchema = z.object({
  name: z.string().min(1),
  match: z.object({
    fromAny: z.array(z.string()).optional(),
    toAny: z.array(z.string()).optional(),
    ccAny: z.array(z.string()).optional(),
    containsAny: z.array(z.string()).optional()
  }),
  actions: z.object({
    moveTo: z.string().min(1).optional(),
    copyTo: z.string().min(1).optional(),
    markRead: z.boolean().optional(),
    flagged: z.boolean().optional()
  }).refine((value) => value.moveTo || value.copyTo || value.markRead || value.flagged !== undefined, "Rule needs an action")
});

export type MailRule = z.infer<typeof ruleSchema>;

export class MailRuleService {
  private constructor(private readonly rules: MailRule[]) {}

  static async load(path?: string): Promise<MailRuleService> {
    if (!path) return new MailRuleService([]);
    const parsed = z.array(ruleSchema).parse(JSON.parse(await readFile(path, "utf8")));
    return new MailRuleService(parsed);
  }

  match(mail: IncomingMail): MailRule | undefined {
    return this.rules.find((rule) => matches(rule, mail));
  }

  destinations(): string[] {
    return [...new Set(this.rules.flatMap((rule) => [rule.actions.moveTo, rule.actions.copyTo].filter((value): value is string => Boolean(value))))];
  }

  get count(): number { return this.rules.length; }
}

function matches(rule: MailRule, mail: IncomingMail): boolean {
  const from = mail.from.map((item) => item.address.toLowerCase());
  const to = mail.to.map((item) => item.address.toLowerCase());
  const cc = mail.cc.map((item) => item.address.toLowerCase());
  const searchable = [mail.subject, mail.text, ...mail.attachments.map((item) => item.filename)].join("\n").toLowerCase();
  return matchAddressGroup(rule.match.fromAny, from)
    && matchAddressGroup(rule.match.toAny, to)
    && matchAddressGroup(rule.match.ccAny, cc)
    && (!rule.match.containsAny?.length || rule.match.containsAny.some((value) => searchable.includes(value.toLowerCase())));
}

function matchAddressGroup(patterns: string[] | undefined, addresses: string[]): boolean {
  if (!patterns?.length) return true;
  return patterns.some((pattern) => addresses.some((address) => addressMatches(pattern, address)));
}

function addressMatches(pattern: string, address: string): boolean {
  const normalized = pattern.toLowerCase().trim();
  if (!normalized.includes("*")) return address === normalized || address.includes(normalized);
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(address);
}
