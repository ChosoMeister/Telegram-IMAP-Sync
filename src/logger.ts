type Level = "debug" | "info" | "warn" | "error";
const ranks: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secretPattern = /(bearer\s+|password["'=:\s]+|api[_-]?key["'=:\s]+|sk-[a-z0-9_-]{8})[^\s"']+/gi;

export function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(secretPattern, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [/pass(word)?/i, /token/i, /secret/i, /api.?key/i].some((p) => p.test(k)) ? [k, "[REDACTED]"] : [k, redact(v)]
    ));
  }
  return value;
}

export class Logger {
  constructor(private readonly minimum: Level = "info") {}
  private write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (ranks[level] < ranks[this.minimum]) return;
    const safeFields = fields ? redact(fields) as Record<string, unknown> : {};
    const record = { ts: new Date().toISOString(), level, message, ...safeFields };
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
  debug(message: string, fields?: Record<string, unknown>): void { this.write("debug", message, fields); }
  info(message: string, fields?: Record<string, unknown>): void { this.write("info", message, fields); }
  warn(message: string, fields?: Record<string, unknown>): void { this.write("warn", message, fields); }
  error(message: string, fields?: Record<string, unknown>): void { this.write("error", message, fields); }
}
