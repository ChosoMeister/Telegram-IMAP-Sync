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
  classification?: "real" | "inline" | "signature" | "uncertain";
  classificationReason?: string;
  sha256?: string;
  width?: number;
  height?: number;
  isRealAttachment: boolean;
}

export interface IncomingMail {
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
}

export interface Analysis {
  importance: Importance;
  score: number;
  summaryFa: string;
  suggestedAction: string;
  deadline?: string;
  reason: string;
  provider: string;
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
