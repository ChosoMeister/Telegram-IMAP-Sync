import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { ImapService } from "./mail/imap.js";
import { SmtpService } from "./mail/smtp.js";
import { loadMailAccountConfigs } from "./accounts.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.APP_MODE !== "dry-run") throw new Error("Discovery must run with APP_MODE=dry-run");
  const logger = new Logger(config.LOG_LEVEL);
  const results = [];
  for (const account of await loadMailAccountConfigs(config)) {
    const imap = new ImapService(account.config, logger, account.id, account.label);
    const smtp = new SmtpService(account.config);
    const discovery = await imap.discoverMailboxes();
    let smtpOk = false;
    let smtpError: string | undefined;
    try { await smtp.verify(); smtpOk = true; } catch (error) { smtpError = error instanceof Error ? error.message : String(error); }
    results.push({ accountId: account.id, label: account.label, imap: discovery,
      archiveCandidates: discovery.mailboxes.filter((m) => m.specialUse === "\\Archive" || /archive|processed|done/i.test(m.path)),
      smtp: { ok: smtpOk, ...(smtpError ? { error: smtpError } : {}) } });
  }
  process.stdout.write(`${JSON.stringify({ accounts: results }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
