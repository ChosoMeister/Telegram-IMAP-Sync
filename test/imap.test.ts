import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "./helpers.js";
import { Logger } from "../src/logger.js";

const mocks = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  return { ImapFlow: class FakeImapClient extends EventEmitter {
    usable = false;
    mailbox: false | { exists: number; uidValidity: bigint } = false;
    capabilities = new Map<string, boolean | number>();
    idling = false;

    constructor(public readonly options: unknown) {
      super();
      mocks.clients.push(this);
    }

    async connect(): Promise<void> { this.usable = true; }
    async mailboxOpen(): Promise<void> { this.mailbox = { exists: 0, uidValidity: 1n }; }
    async logout(): Promise<void> {
      this.usable = false;
      this.mailbox = false;
      this.emit("close");
    }
  } };
});

import { ImapService } from "../src/mail/imap.js";

describe("IMAP Auto-IDLE observability", () => {
  beforeEach(() => mocks.clients.splice(0));

  it("reports supported Auto-IDLE without invoking idle manually", async () => {
    const service = new ImapService(config, new Logger("error"));
    const connecting = service.connect();
    const client = mocks.clients[0]!;
    client.capabilities.set("IDLE", true);
    await connecting;

    expect(service.status()).toMatchObject({ connectionState: "connected", notificationMode: "idle-pending", idleSupported: true, idleActive: false });
    client.idling = true;
    expect(service.status()).toMatchObject({ notificationMode: "idle", idleActive: true });
    await service.stop();
  });

  it("reports the ImapFlow polling fallback when the server lacks IDLE", async () => {
    const service = new ImapService(config, new Logger("error"));
    await service.connect();
    expect(service.status()).toMatchObject({ connectionState: "connected", notificationMode: "polling-fallback", idleSupported: false });
    await service.stop();
  });

  it("observes EXISTS, exits immediately on disconnect, and reconnects with a new client", async () => {
    const service = new ImapService(config, new Logger("error"));
    const firstConnect = service.connect();
    const first = mocks.clients[0]!;
    first.capabilities.set("IDLE", true);
    await firstConnect;

    const onChange = vi.fn().mockResolvedValue(undefined);
    const waiting = service.waitForChanges(onChange);
    first.emit("exists", { count: 1, prevCount: 0 });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce());

    first.usable = false;
    first.mailbox = false;
    first.emit("close");
    await waiting;
    expect(service.status().connectionState).toBe("reconnecting");

    const reconnecting = service.connect();
    await vi.waitFor(() => expect(mocks.clients).toHaveLength(2));
    const second = mocks.clients[1]!;
    second.capabilities.set("IDLE", true);
    await reconnecting;
    expect(service.status()).toMatchObject({ connectionState: "connected", idleSupported: true });
    await service.stop();
  });
});
