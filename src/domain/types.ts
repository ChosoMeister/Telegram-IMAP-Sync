export type Importance = "critical" | "high" | "normal" | "low";
export type MailState = "pending" | "processing" | "done" | "external_done" | "failed";

export interface Address {
  name?: string;
  address: string;
}

export interface MailAttachment {
  partId: string;
  filename: string;
  contentType: string;
  size: number;
  contentDisposition: "attachment" | "inline";
  contentId?: string;
  classification?: "real" | "inline" | "signature" | "uncertain" | "calendar";
  classificationReason?: string;
  sha256?: string;
  width?: number;
  height?: number;
  isRealAttachment: boolean;
}

export interface CalendarEvent {
  parserVersion?: number;
  method?: string;
  uid?: string;
  status?: string;
  sequence?: number;
  recurrenceId?: string;
  summary?: string;
  description?: string;
  location?: string;
  organizer?: Address;
  attendees: Address[];
  start?: { iso?: string; raw: string; timeZone?: string };
  end?: { iso?: string; raw: string; timeZone?: string };
  url?: string;
}

export interface IncomingMail {
  accountId?: string;
  accountLabel?: string;
  uid: number;
  uidValidity: string;
  mailbox: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  subject: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  receivedAt: Date;
  text: string;
  html?: string;
  attachments: MailAttachment[];
  calendar?: CalendarEvent;
}

export interface Analysis {
  importance: Importance;
  score: number;
  summaryFa: string;
  suggestedAction: string;
  deadline?: string;
  keyFactsFa?: string[];
  amountsFa?: string[];
  riskFa?: string;
  actionLinks?: string[];
  reason: string;
  provider: string;
  actionOwner?: "self" | "other" | "shared" | "unknown";
  category?: "actionable" | "informational";
  userCorrected?: boolean;
  appliedRuleIds?: number[];
}

export type LearnedRuleScope = "sender" | "sender_subject" | "domain";
export type LearnedRuleEffect = "importance" | "not_mine" | "informational";

export interface LearnedRule {
  id: number;
  accountId: string;
  scope: LearnedRuleScope;
  senderEmail?: string;
  senderDomain?: string;
  subjectPattern?: string;
  effect: LearnedRuleEffect;
  effectValue?: string;
  enabled: boolean;
  confirmationCount: number;
  sourceMailId?: number;
  createdAt: string;
  updatedAt: string;
}

export type MemoryKind = "preference" | "role" | "correction" | "pattern" | "exception" | "permission";
export type MemoryScope = "global" | "account";
export type MemoryConfidence = "confirmed" | "inferred";
export type MemoryStatus = "active" | "superseded" | "disabled";

export interface MemoryRecord {
  id: number;
  kind: MemoryKind;
  key: string;
  statement: string;
  scope: MemoryScope;
  accountId?: string;
  confidence: MemoryConfidence;
  source: "user" | "model" | "migration";
  sourceMailId?: number;
  sourcePlanId?: number;
  status: MemoryStatus;
  supersedesId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailTask {
  id: number;
  accountId: string;
  title: string;
  state: "open" | "waiting" | "done" | "cancelled";
  mailIds: number[];
  dueAt?: number;
  timezone: string;
  reminderState: "none" | "pending" | "running" | "delivered" | "failed";
  attempts: number;
  dedupeKey: string;
  telegramMessageId?: number;
}

export interface AutomationPolicy {
  id: number;
  name: string;
  category: "informational" | "newsletter" | "marketing";
  action: "archive";
  scope: "global" | "account";
  accountId?: string;
  exceptions: string[];
  status: "active" | "paused";
  source: "user";
  senderAddress?: string;
}

export interface AutomationDecision {
  id: number;
  mailId: number;
  policyId: number;
  outcome: "would_archive" | "executed" | "skipped" | "failed";
  reason: string;
}

export interface StoredMail extends IncomingMail {
  id: number;
  state: MailState;
  analysis?: Analysis;
  telegramMessageIds: number[];
  telegramCreatedAt?: Date;
  lastError?: string;
}

export interface ReplyDraft {
  to: Address[];
  cc: Address[];
  subject: string;
  text: string;
  html: string;
}
