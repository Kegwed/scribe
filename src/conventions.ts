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
    const kind = LINT_CONFIGS.find(({ file: pattern }) => pattern.test(file.split("/").at(-1)!));
    if (!kind) continue;
    const lines = (await readFile(join(repoDir, file), "utf8")).replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
    const text = lines.join("\n");
    if (text.trim() === "") continue;
    evidence.push({ id: file, name: kind.name, file, text, hash: contentHash(text), startLine: 1, endLine: lines.length });
  }
  return evidence;
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
