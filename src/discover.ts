import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { ImapService } from "./mail/imap.js";
import { SmtpService } from "./mail/smtp.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_MODE !== "dry-run") throw new Error("Discovery must run with APP_MODE=dry-run");
  const logger = new Logger(config.LOG_LEVEL);
  const imap = new ImapService(config, logger);
  const smtp = new SmtpService(config);
  const discovery = await imap.discoverMailboxes();
  let smtpOk = false;
  let smtpError: string | undefined;
  try { await smtp.verify(); smtpOk = true; } catch (error) { smtpError = error instanceof Error ? error.message : String(error); }
  process.stdout.write(`${JSON.stringify({
    imap: discovery,
    archiveCandidates: discovery.mailboxes.filter((m) => m.specialUse === "\\Archive" || /archive|processed|done/i.test(m.path)),
    smtp: { ok: smtpOk, ...(smtpError ? { error: smtpError } : {}) }
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
