import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailRuleService } from "../src/rules.js";
import { incoming } from "./helpers.js";

describe("mail rules", () => {
  let directory: string | undefined;
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("matches wildcard senders and requires every configured address group", async () => {
    directory = await mkdtemp(join(tmpdir(), "mail-rules-"));
    const path = join(directory, "rules.json");
    await writeFile(path, JSON.stringify([
      { name: "vendor", match: { fromAny: ["*@example.com"], toAny: ["me@example.com"], containsAny: ["invoice"] }, actions: { moveTo: "Alerts", markRead: true } }
    ]));
    const rules = await MailRuleService.load(path);
    const matched = rules.match({ ...incoming, subject: "Invoice ready" });
    expect(matched?.actions).toEqual({ moveTo: "Alerts", markRead: true });
    expect(rules.destinations()).toEqual(["Alerts"]);
    expect(rules.match({ ...incoming, to: [{ address: "other@example.com" }], subject: "Invoice ready" })).toBeUndefined();
  });
});
