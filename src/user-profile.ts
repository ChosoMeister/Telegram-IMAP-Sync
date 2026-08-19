import { readFile } from "node:fs/promises";
import { z } from "zod";

const identitySchema = z.object({
  email: z.string().email(),
  organization: z.string().min(1).optional(),
  jobTitle: z.string().min(1).optional()
});
const profileSchema = z.object({
  displayNameFa: z.string().min(1),
  displayNameEn: z.string().min(1).optional(),
  nameAliases: z.array(z.string().min(1)).default([]),
  identities: z.array(identitySchema).min(1)
});

export type UserProfile = z.infer<typeof profileSchema>;

export async function loadUserProfile(path?: string): Promise<UserProfile | undefined> {
  if (!path) return undefined;
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = profileSchema.parse(JSON.parse(contents));
  return {
    ...parsed,
    nameAliases: [...new Set([parsed.displayNameFa, ...(parsed.displayNameEn ? [parsed.displayNameEn] : []), ...parsed.nameAliases])],
    identities: parsed.identities.map((identity) => ({ ...identity, email: identity.email.toLowerCase() }))
  };
}

export function normalizeSelfReference(value: string, profile?: UserProfile): { text: string; refersToSelf: boolean } {
  if (!profile) return { text: value, refersToSelf: false };
  let text = value;
  let refersToSelf = false;
  const aliases = [...profile.nameAliases].sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:جناب\\s+آقای|آقای|آقا|مهندس)?\\s*${escaped}`, "giu");
    if (pattern.test(text)) { refersToSelf = true; text = text.replace(pattern, "شما"); }
  }
  if (refersToSelf) {
    text = text
      .replace(/\s+کند(?=[\s.،؛!?]|$)/gu, " کنید")
      .replace(/\s+دهد(?=[\s.،؛!?]|$)/gu, " دهید")
      .replace(/\s+نماید(?=[\s.،؛!?]|$)/gu, " نمایید")
      .replace(/\s+باشد(?=[\s.،؛!?]|$)/gu, " باشید");
  }
  return { text: text.replace(/شما(?:\s+شما)+/gu, "شما").trim(), refersToSelf };
}
