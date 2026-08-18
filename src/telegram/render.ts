import type { StoredMail } from "../domain/types.js";
import { esc } from "./api.js";

const badge = { critical: "🔴", high: "🟠", normal: "🟡", low: "🟢" } as const;

export function renderMail(mail: StoredMail): string {
  const a = mail.analysis;
  const from = mail.from.map((item) => item.name || item.address).join(", ") || "نامشخص";
  const real = mail.attachments.filter((item) => item.isRealAttachment);
  return [
    `${a ? badge[a.importance] : "⚪️"} <b>${a ? `${importanceFa(a.importance)} — ${a.score}/100` : "در انتظار تحلیل AI"}</b>`,
    ``,
    `<b>از:</b> ${esc(from)}`,
    `<b>موضوع:</b> ${esc(mail.subject)}`,
    `<b>زمان:</b> ${esc(new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(mail.receivedAt))}`,
    ``,
    a ? `<b>خلاصه AI:</b>\n${esc(a.summaryFa)}\n\n<b>اقدام پیشنهادی:</b>\n${esc(a.suggestedAction)}` : `<i>ایمیل بدون انتظار برای AI دریافت شد؛ نتیجه بعداً افزوده می‌شود.</i>`,
    real.length ? `\n\n📎 ${real.length} پیوست — ${formatSize(real.reduce((n, x) => n + x.size, 0))}` : ""
  ].join("\n");
}

export function mailButtons(mail: StoredMail) {
  const id = mail.id;
  const rows: Array<Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>> = [
    [{ text: "📄 متن کامل", callback_data: `m:${id}:body`, style: "primary" }]
  ];
  if (mail.attachments.some((a) => a.isRealAttachment)) rows[0]?.push({ text: "📎 دریافت فایل‌ها", callback_data: `m:${id}:files` });
  rows.push([
    { text: "✅ انجام شد", callback_data: `m:${id}:done`, style: "success" },
    { text: "↩️ پاسخ", callback_data: `m:${id}:reply`, style: "primary" }
  ]);
  if (mail.cc.length || mail.to.length > 1) rows[1]?.push({ text: "👥 Reply All", callback_data: `m:${id}:replyall` });
  return rows;
}

function importanceFa(value: keyof typeof badge): string {
  return ({ critical: "خیلی مهم", high: "مهم", normal: "عادی", low: "کم‌اهمیت" })[value];
}
function formatSize(bytes: number): string { return bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
