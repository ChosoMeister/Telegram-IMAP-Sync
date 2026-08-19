import type { StoredMail } from "../domain/types.js";
import { esc } from "./api.js";

const badge = { critical: "🔴", high: "🟠", normal: "🟡", low: "🟢" } as const;

export function renderMail(mail: StoredMail, thread: StoredMail[] = [mail]): string {
  const a = mail.analysis;
  const from = mail.from.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).join(", ") || "نامشخص";
  const real = thread.flatMap((item) => item.attachments.filter((attachment) => attachment.isRealAttachment));
  const hidden = thread.flatMap((item) => item.attachments.filter((attachment) => !attachment.isRealAttachment));
  const timeline = thread.length > 1 ? thread.map((item, index) => {
    const sender = item.from[0]?.name ?? item.from[0]?.address ?? "نامشخص";
    const direction = item.mailbox === mail.mailbox ? "📥" : "📤";
    const summary = (item.analysis?.summaryFa ?? item.text.replace(/\s+/g, " ").slice(0, 120)) || "بدون خلاصه";
    return `${direction} <b>${index + 1}. ${esc(sender)}</b> — ${esc(formatDate(item.receivedAt))}\n${esc(summary)}`;
  }).join("\n\n") : "";
  return [
    `${a ? badge[a.importance] : "⚪️"} <b>${a ? `${importanceFa(a.importance)} — ${a.score}/100` : "در انتظار تحلیل AI"}</b>`,
    ``,
    thread.length > 1 ? `<b>🧵 مکالمه:</b> ${thread.length} پیام در Inbox` : "",
    `<b>آخرین فرستنده:</b> ${esc(from)}`,
    `<b>موضوع:</b> ${esc(mail.subject)}`,
    `<b>زمان:</b> ${esc(formatDate(mail.receivedAt))}`,
    ``,
    a ? `<b>${thread.length > 1 ? "خلاصه آخرین پیام" : "خلاصه AI"}:</b>\n${esc(a.summaryFa)}\n\n<b>اقدام پیشنهادی:</b>\n${esc(a.suggestedAction)}` : `<i>ایمیل بدون انتظار برای AI دریافت شد؛ نتیجه بعداً افزوده می‌شود.</i>`,
    timeline ? `\n<b>روند مکالمه:</b>\n${timeline}` : "",
    real.length ? `\n\n📎 ${real.length} پیوست اصلی — ${formatSize(real.reduce((n, x) => n + x.size, 0))}` : "",
    hidden.length ? `🖼 ${hidden.length} تصویر درون‌متن/امضا مخفی شد` : ""
  ].join("\n");
}

export function mailButtons(mail: StoredMail, thread: StoredMail[] = [mail]) {
  const id = mail.id;
  const rows: Array<Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>> = [
    [
      { text: thread.length > 1 ? "📄 آخرین پیام" : "📄 متن پیام", callback_data: `m:${id}:body`, style: "primary" },
      { text: "📚 متن همه پیام‌ها", callback_data: `m:${id}:allbody`, style: "primary" }
    ]
  ];
  if (thread.some((item) => item.attachments.some((a) => a.isRealAttachment))) rows[0]?.push({ text: "📎 دریافت فایل‌ها", callback_data: `m:${id}:files` });
  if (thread.some((item) => item.attachments.some((a) => !a.isRealAttachment))) rows.push([{ text: "🖼 بررسی تصاویر مخفی", callback_data: `m:${id}:hidden` }]);
  const actionRow = [
    { text: "✅ انجام شد", callback_data: `m:${id}:done`, style: "success" },
    { text: "↩️ پاسخ", callback_data: `m:${id}:reply`, style: "primary" },
    { text: "↪️ فوروارد", callback_data: `m:${id}:forward`, style: "primary" }
  ] as Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>;
  if (mail.cc.length || mail.to.length > 1) actionRow.push({ text: "👥 Reply All", callback_data: `m:${id}:replyall` });
  rows.push(actionRow);
  rows.push([
    { text: "✨ از AI بپرس", callback_data: `m:${id}:ask`, style: "primary" }
  ]);
  return rows;
}

function importanceFa(value: keyof typeof badge): string {
  return ({ critical: "خیلی مهم", high: "مهم", normal: "عادی", low: "کم‌اهمیت" })[value];
}
function formatSize(bytes: number): string { return bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
function formatDate(value: Date): string { return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(value); }
