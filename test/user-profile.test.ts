import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadUserProfile } from "../src/user-profile.js";

describe("user profile working schedule", () => {
  it("loads a validated editable work schedule from the ignored profile file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mailbot-profile-"));
    const path = join(directory, "profile.json");
    await writeFile(path, JSON.stringify({ displayNameFa: "کاربر", identities: [{ email: "owner@example.com" }],
      workingSchedule: { workingDays: ["saturday", "sunday", "monday"], startTime: "10:00", endTime: "18:00" } }));
    await expect(loadUserProfile(path)).resolves.toMatchObject({ workingSchedule: { workingDays: ["saturday", "sunday", "monday"], startTime: "10:00" } });
    await rm(directory, { recursive: true, force: true });
  });
});
