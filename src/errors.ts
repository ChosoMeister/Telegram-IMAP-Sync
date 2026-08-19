export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = error.cause;
  const seen = new Set<unknown>([error]);
  while (cause && !seen.has(cause)) {
    seen.add(cause);
    if (cause instanceof Error) {
      const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
      parts.push([code, cause.message].filter(Boolean).join(": "));
      cause = cause.cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return [...new Set(parts.filter(Boolean))].join(" <- ");
}
