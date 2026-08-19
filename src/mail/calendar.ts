import type { Address, CalendarEvent } from "../domain/types.js";

const windowsZones: Record<string, string> = {
  "iran standard time": "Asia/Tehran",
  "utc": "UTC"
};

export function parseCalendar(content: Buffer | string): CalendarEvent | undefined {
  const lines = unfold(Buffer.isBuffer(content) ? content.toString("utf8") : content);
  if (!lines.some((line) => line.toUpperCase() === "BEGIN:VEVENT")) return undefined;
  const event = between(lines, "BEGIN:VEVENT", "END:VEVENT");
  const method = value(lines, "METHOD");
  const uid = value(event, "UID");
  const status = value(event, "STATUS");
  const summary = value(event, "SUMMARY");
  const description = value(event, "DESCRIPTION");
  const location = value(event, "LOCATION");
  const url = value(event, "URL");
  const start = calendarDate(property(event, "DTSTART"));
  const end = calendarDate(property(event, "DTEND"));
  const organizer = address(property(event, "ORGANIZER"));
  const attendees = event.filter((line) => key(line) === "ATTENDEE").map(address).filter((item): item is Address => Boolean(item));
  return {
    ...(method ? { method: method.toUpperCase() } : {}),
    ...(uid ? { uid } : {}),
    ...(status ? { status: status.toUpperCase() } : {}),
    ...(summary ? { summary: decode(summary) } : {}),
    ...(description ? { description: decode(description) } : {}),
    ...(location ? { location: decode(location) } : {}),
    ...(organizer ? { organizer } : {}),
    attendees,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(url ? { url: decode(url) } : {})
  };
}

function unfold(value: string): string[] {
  return value.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).map((line) => line.trimEnd());
}
function between(lines: string[], start: string, end: string): string[] {
  const from = lines.findIndex((line) => line.toUpperCase() === start);
  const to = lines.findIndex((line, index) => index > from && line.toUpperCase() === end);
  return from >= 0 ? lines.slice(from + 1, to >= 0 ? to : undefined) : [];
}
function key(line: string): string { return line.split(/[;:]/, 1)[0]!.toUpperCase(); }
function property(lines: string[], name: string): string | undefined { return lines.find((line) => key(line) === name); }
function value(lines: string[], name: string): string | undefined {
  const line = property(lines, name); const colon = line?.indexOf(":") ?? -1;
  return colon >= 0 ? line!.slice(colon + 1) : undefined;
}
function decode(value: string): string {
  return value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\").trim();
}
function address(line?: string): Address | undefined {
  if (!line) return undefined;
  const colon = line.indexOf(":");
  const email = (colon >= 0 ? line.slice(colon + 1) : line).replace(/^mailto:/i, "").trim();
  if (!email) return undefined;
  const cn = /(?:^|;)CN=(?:"([^"]+)"|([^;:]+))/i.exec(line);
  const name = decode(cn?.[1] ?? cn?.[2] ?? "");
  return { ...(name ? { name } : {}), address: email };
}
function calendarDate(line?: string): CalendarEvent["start"] | undefined {
  if (!line) return undefined;
  const colon = line.indexOf(":"); if (colon < 0) return undefined;
  const raw = line.slice(colon + 1).trim();
  const requestedZone = /(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i.exec(line);
  const originalZone = requestedZone?.[1] ?? requestedZone?.[2];
  const timeZone = originalZone ? windowsZones[originalZone.toLowerCase()] ?? originalZone : raw.endsWith("Z") ? "UTC" : undefined;
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/.exec(raw);
  if (!match) return { raw, ...(timeZone ? { timeZone } : {}) };
  const parts = match.slice(1).map((item) => Number(item || 0));
  let epoch = Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!);
  if (timeZone && timeZone !== "UTC" && !raw.endsWith("Z")) {
    try {
      for (let i = 0; i < 2; i++) {
        const shown = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(epoch).map((part) => [part.type, part.value]));
        const represented = Date.UTC(Number(shown.year), Number(shown.month) - 1, Number(shown.day), Number(shown.hour), Number(shown.minute), Number(shown.second));
        epoch += Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!) - represented;
      }
    } catch { return { raw, timeZone }; }
  }
  return { raw, iso: new Date(epoch).toISOString(), ...(timeZone ? { timeZone } : {}) };
}
