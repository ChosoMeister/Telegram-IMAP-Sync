import { readFile } from "node:fs/promises";
import { z } from "zod";

export type Honorific = "خانم" | "آقای";
export type HonorificDirectory = Record<string, Honorific>;

const schema = z.record(z.string(), z.enum(["خانم", "آقای"]));

export async function loadHonorifics(path?: string): Promise<HonorificDirectory> {
  if (!path) return {};
  try {
    const parsed = schema.parse(JSON.parse(await readFile(path, "utf8")));
    return Object.fromEntries(Object.entries(parsed).map(([email, value]) => [email.trim().toLowerCase(), value]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
