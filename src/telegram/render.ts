import type { StoredMail } from "../domain/types.js";
import { esc } from "./api.js";

const badge = { critical: "🔴", high: "🟠", normal: "🟡", low: "🟢" } as const;

export function renderMail(mail: StoredMail, thread: StoredMail[] = [mail]): string {
  if (mail.calendar) return renderCalendarMail(mail, thread);
  const a = mail.analysis;
  const from = mail.from.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).join(", ") || "نامشخص";
  const real = thread.flatMap((item) => item.attachments.filter((attachment) => attachment.isRealAttachment));
  const hidden = thread.flatMap((item) => item.attachments.filter((attachment) => !attachment.isRealAttachment && attachment.classification !== "calendar"));
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
  type Button = { text: string; callback_data: string; style?: "danger" | "success" | "primary" };
  const rows: Button[][] = [[
    { text: "↩️ پاسخ", callback_data: `m:${id}:reply`, style: "primary" },
    { text: "✅ انجام شد", callback_data: `m:${id}:done`, style: "success" }
  ]];
  const secondary: Button[] = [{ text: "↪️ فوروارد", callback_data: `m:${id}:forward` }];
  if (mail.cc.length || mail.to.length > 1) secondary.push({ text: "👥 پاسخ به همه", callback_data: `m:${id}:replyall` });
  rows.push(secondary);

  const bodyRow: Button[] = [{ text: thread.length > 1 ? "📄 آخرین پیام" : "📄 متن پیام", callback_data: `m:${id}:body` }];
  if (thread.length > 1) {
    bodyRow.push({ text: "📚 همه پیام‌ها", callback_data: `m:${id}:allbody` });
    rows.push(bodyRow, [{ text: "✨ پرسش از AI", callback_data: `m:${id}:ask`, style: "primary" }]);
  } else {
    bodyRow.push({ text: "✨ پرسش از AI", callback_data: `m:${id}:ask`, style: "primary" });
    rows.push(bodyRow);
  }

  const realCount = thread.reduce((count, item) => count + item.attachments.filter((attachment) => attachment.isRealAttachment).length, 0);
  const hiddenCount = thread.reduce((count, item) => count + item.attachments.filter((attachment) => !attachment.isRealAttachment && attachment.classification !== "calendar").length, 0);
  if (realCount) rows.push([{ text: `📎 پیوست‌ها (${realCount})`, callback_data: `m:${id}:files` }]);
  if (hiddenCount) rows.push([{ text: `🖼 موارد مخفی (${hiddenCount})`, callback_data: `m:${id}:hidden` }]);
  return rows;
}

function renderCalendarMail(mail: StoredMail, thread: StoredMail[]): string {
  const event = mail.calendar!;
  const organizer = event.organizer
    ? event.organizer.name ? `${event.organizer.name} <${event.organizer.address}>` : event.organizer.address
    : mail.from.map((item) => item.name ? `${item.name} <${item.address}>` : item.address).join(", ") || "نامشخص";
  const type = event.method === "CANCEL" || event.status === "CANCELLED" ? "لغو رویداد" : event.method === "REPLY" ? "پاسخ به دعوت" : "دعوت تقویم";
  const action = event.method === "CANCEL" || event.status === "CANCELLED" ? "بررسی لغو یا تغییر برنامه" : "بررسی زمان رویداد و پاسخ به دعوت";
  const attendeeLimit = 20;
  const attendeeLines = event.attendees.slice(0, attendeeLimit).map((attendee) => `• ${attendee.name || "نام ثبت نشده"}`);
  if (event.attendees.length > attendeeLimit) attendeeLines.push(`• و ${event.attendees.length - attendeeLimit} نفر دیگر`);
  return [
    `📅 <b>${type}</b>`,
    thread.length > 1 ? `\n<b>🧵 مکالمه:</b> ${thread.length} پیام در Inbox` : "",
    `\n<b>عنوان:</b> ${esc(event.summary || mail.subject)}`,
    `<b>برگزارکننده:</b> ${esc(organizer)}`,
    event.start ? `<b>شروع:</b> ${esc(formatCalendarDate(event.start))}` : "",
    event.end ? `<b>پایان:</b> ${esc(formatCalendarDate(event.end))}` : "",
    event.location ? `<b>محل/جلسه:</b> ${esc(event.location)}` : "",
    event.url ? `<b>پیوند:</b> ${esc(event.url)}` : "",
    event.attendees.length ? `<b>شرکت‌کنندگان (${event.attendees.length} نفر):</b>\n${esc(attendeeLines.join("\n"))}` : "",
    event.description ? `\n<b>توضیحات رویداد:</b>\n${esc(event.description.slice(0, 1200))}` : mail.text ? `\n<b>متن همراه:</b>\n${esc(mail.text.slice(0, 1200))}` : "",
    `\n<b>اقدام پیشنهادی:</b>\n${action}`
  ].filter(Boolean).join("\n");
}

function formatCalendarDate(value: NonNullable<NonNullable<StoredMail["calendar"]>["start"]>): string {
  if (!value.iso) return `${value.raw}${value.timeZone ? ` (${value.timeZone})` : ""}`;
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Tehran" }).format(new Date(value.iso));
}

function importanceFa(value: keyof typeof badge): string {
  return ({ critical: "خیلی مهم", high: "مهم", normal: "عادی", low: "کم‌اهمیت" })[value];
}
function formatSize(bytes: number): string { return bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`; }
function formatDate(value: Date): string { return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran" }).format(value); }
