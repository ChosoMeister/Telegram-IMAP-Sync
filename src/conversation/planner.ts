export type ConversationIntent =
  | { kind: "archive" }
  | { kind: "reply"; replyAll: boolean }
  | { kind: "forward" }
  | { kind: "cancel" }
  | { kind: "ask"; question: string };

const normalize = (text: string): string => text.trim().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\s+/g, " ");

/** A fail-closed first-stage planner. It can only select an action for the already trusted card reference. */
export function planConversation(text: string): ConversationIntent {
  const value = normalize(text);
  if (/^(لغو|کنسل|بی ?خیال|برگرد)$/.test(value)) return { kind: "cancel" };
  if (/(انجام شد|آرشیو(?:ش)? کن|از اینباکس (?:بردار|خارج کن))/.test(value)) return { kind: "archive" };
  if (/(پاسخ به همه|ریپلای آل|reply all)/i.test(value)) return { kind: "reply", replyAll: true };
  if (/(پاسخ بده|جواب بده|ریپلای کن|reply کن)/i.test(value)) return { kind: "reply", replyAll: false };
  if (/(فوروارد|forward)/i.test(value)) return { kind: "forward" };
  return { kind: "ask", question: value };
}
