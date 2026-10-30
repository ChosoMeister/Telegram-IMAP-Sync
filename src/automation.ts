import type { AutomationDecision, AutomationPolicy, StoredMail } from "./domain/types.js";
import type { Store } from "./store.js";

export type AutomationMode = "off" | "observe" | "execute";

export class AutomationService {
  constructor(private readonly store: Store, private readonly mode: AutomationMode,
    private readonly archive: (mail: StoredMail) => Promise<void>) {}

  async evaluate(mail: StoredMail, eligibleNewMail: boolean): Promise<AutomationDecision | undefined> {
    if (this.mode === "off") return undefined;
    const policy = this.matchingPolicy(mail);
    if (!policy) return undefined;
    const exactSender = Boolean(policy.senderAddress);
    const exception = policy.exceptions.find((value) => this.haystack(mail).includes(value.toLowerCase()));
    if (exception) return this.record(mail, policy, "skipped", `استثنا «${exception}» در ایمیل دیده شد؛ خودکارسازی اجرا نشد.`);
    if (!exactSender && mail.analysis && ["critical", "high"].includes(mail.analysis.importance)) {
      return this.record(mail, policy, "skipped", "ایمیل مهم است؛ برای حفظ اعلان و بررسی کاربر خودکار آرشیو نشد.");
    }
    if (!eligibleNewMail) return this.record(mail, policy, "skipped", "ایمیل پیش از فعال‌شدن این حالت دریافت شده و خارج از دامنه خودکارسازی است.");
    const reason = exactSender
      ? `قانون «${policy.name}» با آدرس دقیق فرستنده ${policy.senderAddress} منطبق شد.`
      : `قانون «${policy.name}» منطبق شد: پیام ${policy.category} است، اقدام مستقیم کاربر ندارد و استثنایی دیده نشد.`;
    if (this.mode === "observe") return this.record(mail, policy, "would_archive", reason);
    try {
      await this.archive(mail);
      return this.record(mail, policy, "executed", reason);
    } catch (error) {
      return this.record(mail, policy, "failed", `${reason} خطای اجرا: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private matchingPolicy(mail: StoredMail): AutomationPolicy | undefined {
    const scoped = this.store.listAutomationPolicies(true)
      .filter((policy) => policy.scope === "global" || policy.accountId === (mail.accountId ?? "primary"));
    const senders = new Set(mail.from.map((sender) => sender.address.trim().toLowerCase()));
    return scoped.find((policy) => Boolean(policy.senderAddress && senders.has(policy.senderAddress)))
      ?? (mail.analysis ? scoped.find((policy) => !policy.senderAddress && this.matchesCategory(policy.category, mail)) : undefined);
  }

  private matchesCategory(category: AutomationPolicy["category"], mail: StoredMail): boolean {
    if (mail.analysis?.category !== "informational" || mail.analysis.actionOwner === "self" || mail.analysis.actionOwner === "shared") return false;
    if (category === "informational") return true;
    const value = this.haystack(mail);
    return category === "newsletter" ? /(newsletter|خبرنامه|unsubscribe|لغو اشتراک)/iu.test(value)
      : /(تبلیغ|promotion|offer|تخفیف|فروش ویژه)/iu.test(value);
  }

  private haystack(mail: StoredMail): string { return `${mail.subject}\n${mail.text}`.toLowerCase(); }
  private record(mail: StoredMail, policy: AutomationPolicy, outcome: AutomationDecision["outcome"], reason: string): AutomationDecision {
    return this.store.saveAutomationDecision({ mailId: mail.id, policyId: policy.id, outcome, reason }, {
      importance: mail.analysis?.importance, actionOwner: mail.analysis?.actionOwner, category: mail.analysis?.category
    });
  }
}
