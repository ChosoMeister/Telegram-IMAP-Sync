import type { IncomingMail } from "../domain/types.js";

export function normalizeMessageId(value?: string): string | undefined {
  const normalized = value?.trim().replace(/^<|>$/g, "").toLowerCase();
  return normalized || undefined;
}

export function deriveThreadKey(mail: Pick<IncomingMail, "messageId" | "inReplyTo" | "references" | "mailbox" | "uidValidity" | "uid">): string {
  const root = normalizeMessageId(mail.references[0])
    ?? normalizeMessageId(mail.inReplyTo)
    ?? normalizeMessageId(mail.messageId);
  return root ? `mid:${root}` : `uid:${mail.mailbox}:${mail.uidValidity}:${mail.uid}`;
}
