import type { Analysis, Importance, LearnedRule, LearnedRuleEffect, LearnedRuleScope, StoredMail } from "./domain/types.js";
import type { Store } from "./store.js";

export interface FeedbackChoice {
  effect: LearnedRuleEffect;
  effectValue?: string;
}

export interface RuleProposal extends FeedbackChoice {
  accountId: string;
  scope: LearnedRuleScope;
  senderEmail?: string;
  senderDomain?: string;
  subjectPattern?: string;
  sourceMailId: number;
}

const importanceScore: Record<Importance, number> = { critical: 95, high: 80, normal: 55, low: 25 };

export class LearnedRuleService {
  constructor(private readonly store: Store) {}

  applyUserCorrection(analysis: Analysis, choice: FeedbackChoice): Analysis {
    return this.applyEffect({ ...analysis, userCorrected: true }, choice);
  }

  applyMatching(mail: StoredMail, analysis: Analysis): Analysis {
    const selected = this.selectByEffect(this.matching(mail));
    let result = analysis;
    for (const effect of ["importance", "not_mine", "informational"] as const) {
      const rule = selected.get(effect);
      if (rule) result = this.applyEffect(result, { effect: rule.effect, ...(rule.effectValue ? { effectValue: rule.effectValue } : {}) });
    }
    const ids = [...selected.values()].map((rule) => rule.id);
    return ids.length ? { ...result, appliedRuleIds: ids } : result;
  }

  trustedGuidance(mail: StoredMail): string | undefined {
    const rules = [...this.selectByEffect(this.matching(mail)).values()];
    if (!rules.length) return undefined;
    return rules.map((rule) => {
      if (rule.effect === "importance") return `Verified user rule #${rule.id}: importance must be ${rule.effectValue}.`;
      if (rule.effect === "not_mine") return `Verified user rule #${rule.id}: the requested action is not owned by the mailbox owner.`;
      return `Verified user rule #${rule.id}: this is informational and requires no direct action from the mailbox owner; importance must stay low.`;
    }).join("\n");
  }

  proposal(mail: StoredMail, choice: FeedbackChoice, scope: LearnedRuleScope): RuleProposal | undefined {
    const senderEmail = mail.from[0]?.address.trim().toLowerCase();
    if (!senderEmail) return undefined;
    const senderDomain = senderEmail.split("@")[1];
    if (scope === "domain" && !senderDomain) return undefined;
    const subjectPattern = scope === "sender_subject" ? normalizeSubject(mail.subject) : undefined;
    if (scope === "sender_subject" && !subjectPattern) return undefined;
    return {
      ...choice, scope, accountId: mail.accountId ?? "primary", sourceMailId: mail.id,
      ...(scope === "domain" ? { senderDomain: senderDomain! } : { senderEmail }),
      ...(subjectPattern ? { subjectPattern } : {})
    };
  }

  save(proposal: RuleProposal): LearnedRule { return this.store.saveLearnedRule(proposal); }
  list(): LearnedRule[] { return this.store.listLearnedRules(true); }
  toggle(id: number): LearnedRule | undefined {
    const current = this.store.getLearnedRule(id);
    return current ? this.store.setLearnedRuleEnabled(id, !current.enabled) : undefined;
  }

  describe(rule: LearnedRule): string {
    const condition = rule.scope === "domain" ? `دامنه ${rule.senderDomain}`
      : rule.scope === "sender_subject" ? `${rule.senderEmail} + موضوع «${rule.subjectPattern}»`
        : `فرستنده ${rule.senderEmail}`;
    return `${condition} ← ${effectLabel(rule.effect, rule.effectValue)}`;
  }

  private matching(mail: StoredMail): LearnedRule[] {
    const accountId = mail.accountId ?? "primary";
    const sender = mail.from[0]?.address.trim().toLowerCase() ?? "";
    const domain = sender.split("@")[1] ?? "";
    const subject = normalizeSubject(mail.subject);
    return this.store.listLearnedRules(false)
      .filter((rule) => rule.accountId === accountId)
      .filter((rule) => rule.scope === "domain" ? rule.senderDomain === domain
        : rule.scope === "sender_subject" ? rule.senderEmail === sender && rule.subjectPattern === subject
          : rule.senderEmail === sender)
      .sort((a, b) => specificity(b.scope) - specificity(a.scope) || b.id - a.id);
  }

  private selectByEffect(rules: LearnedRule[]): Map<LearnedRuleEffect, LearnedRule> {
    const selected = new Map<LearnedRuleEffect, LearnedRule>();
    for (const rule of rules) if (!selected.has(rule.effect)) selected.set(rule.effect, rule);
    return selected;
  }

  private applyEffect(analysis: Analysis, choice: FeedbackChoice): Analysis {
    if (choice.effect === "importance") {
      const importance = isImportance(choice.effectValue) ? choice.effectValue : "normal";
      return { ...analysis, importance, score: importanceScore[importance] };
    }
    if (choice.effect === "not_mine") {
      return {
        ...analysis, actionOwner: "other",
        suggestedAction: "اقدام اصلی این ایمیل بر عهده شما نیست؛ در صورت نیاز فقط روند آن را پیگیری کنید."
      };
    }
    const corrected = { ...analysis };
    delete corrected.riskFa;
    return {
      ...corrected, importance: "low", score: Math.min(analysis.score, 30), category: "informational", actionOwner: "other",
      suggestedAction: "این پیام صرفاً اطلاع‌رسانی است و اقدام مستقیمی از شما نمی‌خواهد."
    };
  }
}

export function normalizeSubject(subject: string): string {
  return subject.replace(/^\s*(?:(?:re|fw|fwd)\s*:\s*)+/iu, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);
}

export function effectLabel(effect: LearnedRuleEffect, value?: string): string {
  if (effect === "not_mine") return "اقدام مربوط به من نیست";
  if (effect === "informational") return "صرفاً اطلاع‌رسانی، حداکثر ۳۰";
  return `اهمیت ${importanceLabel(value)}`;
}

function importanceLabel(value?: string): string {
  return ({ critical: "خیلی مهم", high: "مهم", normal: "عادی", low: "کم‌اهمیت" } as Record<string, string>)[value ?? ""] ?? "عادی";
}

function isImportance(value?: string): value is Importance { return ["critical", "high", "normal", "low"].includes(value ?? ""); }
function specificity(scope: LearnedRuleScope): number { return scope === "sender_subject" ? 3 : scope === "sender" ? 2 : 1; }
