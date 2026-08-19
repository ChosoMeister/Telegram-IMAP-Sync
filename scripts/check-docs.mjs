import { readFile, access } from "node:fs/promises";
import { stdout } from "node:process";

const requiredDocs = [
  "README.md", "README.fa.md", "CHANGELOG.md", ".env.example",
  "docs/CONFIGURATION.md", "docs/OPERATIONS.md", "docs/MAIL_RULES.md",
  "docs/SPEC.md", "docs/ARCHITECTURE.md", "docs/MAINTENANCE.md",
  "docs/MULTI_ACCOUNT_DESIGN.md"
];

await Promise.all(requiredDocs.map((path) => access(path)));

const pkg = JSON.parse(await readFile("package.json", "utf8"));
const readme = await readFile("README.md", "utf8");
const changelog = await readFile("CHANGELOG.md", "utf8");
if (!readme.includes(`:${pkg.version}`)) throw new Error(`README.md does not reference image version ${pkg.version}`);
if (!changelog.includes(`## ${pkg.version} `)) throw new Error(`CHANGELOG.md has no ${pkg.version} release heading`);

const configSource = await readFile("src/config.ts", "utf8");
const envExample = await readFile(".env.example", "utf8");
const configDoc = await readFile("docs/CONFIGURATION.md", "utf8");
const schemaKeys = [...configSource.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]);
const envKeys = [...envExample.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);

const missingFromExample = schemaKeys.filter((key) => !envKeys.includes(key));
const unknownInExample = envKeys.filter((key) => !schemaKeys.includes(key));
const missingFromDocs = schemaKeys.filter((key) => !configDoc.includes(`\`${key}\``));
const errors = [];
if (missingFromExample.length) errors.push(`missing from .env.example: ${missingFromExample.join(", ")}`);
if (unknownInExample.length) errors.push(`unknown in .env.example: ${unknownInExample.join(", ")}`);
if (missingFromDocs.length) errors.push(`missing from docs/CONFIGURATION.md: ${missingFromDocs.join(", ")}`);
if (errors.length) throw new Error(`Documentation drift detected:\n- ${errors.join("\n- ")}`);

stdout.write(`Documentation is consistent for v${pkg.version} (${schemaKeys.length} environment variables).\n`);
