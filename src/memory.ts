import type { MemoryConfidence, MemoryKind, MemoryRecord, MemoryScope, StoredMail } from "./domain/types.js";
import type { Store } from "./store.js";

export interface RememberInput {
  kind: MemoryKind;
  key: string;
  statement: string;
  scope: MemoryScope;
  accountId?: string;
  confidence: MemoryConfidence;
  source: "user" | "model" | "migration";
  sourceMailId?: number;
  sourcePlanId?: number;
}

export class MemoryService {
  constructor(private readonly store: Store) {}

  remember(input: RememberInput): MemoryRecord {
    return this.store.saveMemory({ ...input, key: normalizeKey(input.key), statement: input.statement.trim() });
  }

  trustedGuidance(mail: Pick<StoredMail, "accountId">): string | undefined {
    const accountId = mail.accountId ?? "primary";
    const memories = this.store.listMemories(false)
      .filter((memory) => memory.confidence === "confirmed")
      .filter((memory) => memory.scope === "global" || memory.accountId === accountId);
    if (!memories.length) return undefined;
    return memories.map((memory) => `Confirmed memory #${memory.id} (${memory.kind}, ${memory.scope}): ${memory.statement}`).join("\n");
  }

  list(): MemoryRecord[] { return this.store.listMemories(false); }
  toggle(id: number): MemoryRecord | undefined {
    const memory = this.store.getMemory(id);
    return memory ? this.store.setMemoryEnabled(id, memory.status !== "active") : undefined;
  }
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_\-\u0600-\u06ff]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}
