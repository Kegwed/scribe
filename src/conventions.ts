import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol } from "./analyser.ts";
import type { DocEvidence } from "./docs.ts";
import { contentHash } from "./hash.ts";
import type { Module } from "./modules.ts";
import type { FileEvidence } from "./section-writer.ts";

/** The Conventions Section's id, which is also its file's path in the Guide, without the extension. */
export const CONVENTIONS = "conventions";

/** What each kind of lint or format config file is called in a citation, by its file name. */
const LINT_CONFIGS: { name: string; file: RegExp }[] = [
  { name: "ESLint config", file: /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.(?:c?js|json|ya?ml))?)$/ },
  { name: "Prettier config", file: /^(?:prettier\.config\.[cm]?[jt]s|\.prettierrc(?:\.(?:[cm]?js|json5?|ya?ml|toml))?)$/ },
  { name: "Biome config", file: /^biome\.jsonc?$/ },
  { name: "Stylelint config", file: /^(?:stylelint\.config\.[cm]?js|\.stylelintrc(?:\.(?:[cm]?js|json|ya?ml))?)$/ },
  { name: "EditorConfig", file: /^\.editorconfig$/ },
];

/**
 * The Target repo's lint and format config files, each one piece of Evidence
 * holding the whole file: its id is the file's path. Files under `guideDir`,
 * hidden directories and `node_modules` are never read.
 */
export async function lintConfigEvidence(repoDir: string, guideDir: string): Promise<FileEvidence[]> {
  const guide = `${guideDir.replace(/\/+$/, "")}/`;
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoDir, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && !f.startsWith(guide) && existsSync(join(repoDir, f)))
    .filter((f) => !f.split("/").slice(0, -1).some((s) => s.startsWith(".") || s === "node_modules"))
    .sort();
  const evidence: FileEvidence[] = [];
  for (const file of files) {
    const fileName = file.split("/").at(-1)!;
    if (fileName === "package.json") {
      evidence.push(...packageJsonConfig(file, await readFile(join(repoDir, file), "utf8")));
      continue;
    }
    const kind = LINT_CONFIGS.find(({ file: pattern }) => pattern.test(fileName));
    if (!kind) continue;
    const lines = (await readFile(join(repoDir, file), "utf8")).replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    const text = lines.join("\n");
    if (text.trim() === "") continue;
    evidence.push({ id: file, name: kind.name, file, text, hash: contentHash(text), startLine: 1, endLine: lines.length });
  }
  return evidence;
}

/** What each lint or format config kept under a key of package.json is called in a citation, by its key. */
const PACKAGE_JSON_CONFIGS: Record<string, string> = {
  eslintConfig: "ESLint config",
  prettier: "Prettier config",
  stylelint: "Stylelint config",
};

/**
 * One piece of Evidence per lint or format config kept under a key of a
 * package.json, its id `<file>#<key>`. Its text is the key's value, so the
 * rest of package.json can change without making Conventions Stale.
 */
function packageJsonConfig(file: string, content: string): FileEvidence[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  return Object.entries(PACKAGE_JSON_CONFIGS).flatMap(([key, name]) => {
    if (!Object.hasOwn(parsed, key)) return [];
    const text = `${JSON.stringify(key)}: ${JSON.stringify((parsed as Record<string, unknown>)[key], null, 2)}`;
    const start = Math.max(0, lines.findIndex((line) => line.includes(`${JSON.stringify(key)}:`)));
    return [{ id: `${file}#${key}`, name, file, text, hash: contentHash(text), startLine: start + 1, endLine: valueEnd(lines, start) + 1 }];
  });
}

/** The index of the line a JSON value starting on line `start` ends on, found by matching its brackets outside strings. */
function valueEnd(lines: string[], start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!;
    // The key itself is a string, so scanning starts after its colon.
    for (let j = i === start ? line.indexOf(":") + 1 : 0; j < line.length; j++) {
      const c = line[j];
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
    }
    if (depth <= 0 && !inString) return i;
  }
  return lines.length - 1;
}

/** How many of each Module's exported symbols Conventions is shown, as samples of how the code is written. */
const SAMPLE_SYMBOLS = 3;

/**
 * Everything the Conventions Section is written from: the lint and format
 * config, the passages of CONTRIBUTING files, and a sample of each Module's
 * exported symbols, in that order.
 */
export function conventionsEvidence(
  { lintConfig, docs, symbols, modules }: { lintConfig: FileEvidence[]; docs: DocEvidence[]; symbols: CodeSymbol[]; modules: Module[] },
): FileEvidence[] {
  const contributing = docs.filter(({ file }) => /^contributing(?:\.[^/]*)?\.mdx?$/i.test(file.split("/").at(-1)!));
  const samples = modules.flatMap(({ path }) =>
    symbols.filter((s) => s.module === path && s.exportedAs.length > 0).slice(0, SAMPLE_SYMBOLS));
  return [...lintConfig, ...contributing, ...samples];
}

/** Whether Conventions has anything to be written from: code samples alone show no convention. */
export function hasConventions(evidence: FileEvidence[]): boolean {
  return evidence.some((e) => !("exportedAs" in e));
}
