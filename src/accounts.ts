import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ImapService } from "./mail/imap.js";
import type { SmtpService } from "./mail/smtp.js";

const bool = z.enum(["true", "false"]).transform((value) => value === "true");
const accountSchema = z.object({
  ACCOUNT_ID: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  ACCOUNT_LABEL: z.string().min(1),
  IMAP_HOST: z.string().min(1), IMAP_PORT: z.coerce.number().int().default(993), IMAP_SECURE: bool.default(true),
  IMAP_USER: z.string().min(1), IMAP_PASSWORD: z.string().min(1), IMAP_MAILBOX: z.string().default("INBOX"),
  IMAP_ARCHIVE_MAILBOX: z.string().optional(), IMAP_SENT_MAILBOX: z.string().optional(),
  SMTP_HOST: z.string().min(1), SMTP_PORT: z.coerce.number().int().default(587), SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().min(1), SMTP_PASSWORD: z.string().min(1), SMTP_FROM: z.string().email()
});

export interface MailAccountConfig { id: string; label: string; config: AppConfig }
export interface MailAccountRuntime extends MailAccountConfig { imap: ImapService; smtp: SmtpService }

function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("Invalid account environment line");
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export async function loadMailAccountConfigs(config: AppConfig): Promise<MailAccountConfig[]> {
  const accounts: MailAccountConfig[] = [{ id: config.PRIMARY_ACCOUNT_ID, label: config.PRIMARY_ACCOUNT_LABEL, config }];
  const paths = (config.MAIL_ACCOUNT_FILES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  for (const path of paths) {
    const parsed = accountSchema.parse(parseEnv(await readFile(path, "utf8")));
    accounts.push({
      id: parsed.ACCOUNT_ID, label: parsed.ACCOUNT_LABEL,
      config: {
        ...config,
        IMAP_HOST: parsed.IMAP_HOST, IMAP_PORT: parsed.IMAP_PORT, IMAP_SECURE: parsed.IMAP_SECURE,
        IMAP_USER: parsed.IMAP_USER, IMAP_PASSWORD: parsed.IMAP_PASSWORD, IMAP_MAILBOX: parsed.IMAP_MAILBOX,
        IMAP_ARCHIVE_MAILBOX: parsed.IMAP_ARCHIVE_MAILBOX, IMAP_SENT_MAILBOX: parsed.IMAP_SENT_MAILBOX,
        SMTP_HOST: parsed.SMTP_HOST, SMTP_PORT: parsed.SMTP_PORT, SMTP_SECURE: parsed.SMTP_SECURE,
        SMTP_USER: parsed.SMTP_USER, SMTP_PASSWORD: parsed.SMTP_PASSWORD, SMTP_FROM: parsed.SMTP_FROM
      }
    });
  }
  const ids = accounts.map((account) => account.id);
  if (new Set(ids).size !== ids.length) throw new Error("Mail account IDs must be unique");
  return accounts;
}
