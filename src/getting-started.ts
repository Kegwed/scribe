import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash } from "./hash.ts";
import type { FileEvidence } from "./section-writer.ts";

/** The Getting started Section's id, which is also its file's path in the Guide, without the extension. */
export const GETTING_STARTED = "getting-started";

/**
 * Evidence the Getting started Section is written from: one item per
 * `package.json` script, CI workflow step that runs commands, and shell block
 * in the repo's existing docs, each with the commands it lets a reader run.
 */
export interface SetupEvidence extends FileEvidence {
  /** Commands this item shows to exist, whitespace normalised. */
  commands: string[];
}

/** The Target repo's setup Evidence; the Guide itself is never read as Evidence. */
export async function setupEvidence(repoDir: string, guideDir: string): Promise<SetupEvidence[]> {
  const files = listFiles(repoDir);
  const guide = `${guideDir.replace(/\/+$/, "")}/`;
  const workflows = files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)).sort();
  const docs = files.filter((f) => isDoc(f) && !f.startsWith(guide)).sort();
  return [
    ...(await scriptEvidence(repoDir, files)),
    ...(await Promise.all(workflows.map(async (f) => stepEvidence(f, await readFile(join(repoDir, f), "utf8"))))).flat(),
    ...(await Promise.all(docs.map(async (f) => docEvidence(f, await readFile(join(repoDir, f), "utf8"))))).flat(),
  ];
}

/**
 * Commands named in a Claim's text, as inline code spans, that none of
 * `evidence` shows to exist. Checked by matching text alone, never by a model.
 */
export function unmatchedCommands(text: string, evidence: SetupEvidence[]): string[] {
  const known = new Set(evidence.flatMap((e) => e.commands));
  return [...text.matchAll(/`([^`]+)`/g)].map(([, command]) => normalise(command!)).filter((command) => !known.has(command));
}

function normalise(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** Tracked and untracked files git doesn't ignore, repo-relative. */
function listFiles(repoDir: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: repoDir, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(repoDir, f)));
}

function isDoc(file: string): boolean {
  if (/^(readme|contributing)\.md$/i.test(file)) return true;
  return file.startsWith("docs/") && file.endsWith(".md");
}

/** Lockfile each package manager writes, and how it runs a `package.json` script. */
const PACKAGE_MANAGERS: { lockfiles: string[]; run: (script: string) => string[] }[] = [
  { lockfiles: ["pnpm-lock.yaml"], run: (s) => [`pnpm ${s}`, `pnpm run ${s}`] },
  { lockfiles: ["yarn.lock"], run: (s) => [`yarn ${s}`, `yarn run ${s}`] },
  { lockfiles: ["bun.lock", "bun.lockb"], run: (s) => [`bun run ${s}`] },
];
/** Scripts npm runs without `run`. */
const NPM_SHORTHANDS = new Set(["test", "start", "stop", "restart"]);

function runScript(files: string[], script: string): string[] {
  const manager = PACKAGE_MANAGERS.find(({ lockfiles }) => lockfiles.some((l) => files.includes(l)));
  if (manager) return manager.run(script);
  return [`npm run ${script}`, ...(NPM_SHORTHANDS.has(script) ? [`npm ${script}`] : [])];
}

async function scriptEvidence(repoDir: string, files: string[]): Promise<SetupEvidence[]> {
  const file = "package.json";
  if (!files.includes(file)) return [];
  const content = await readFile(join(repoDir, file), "utf8");
  let scripts: unknown;
  try {
    scripts = JSON.parse(content)?.scripts;
  } catch {
    return [];
  }
  if (typeof scripts !== "object" || scripts === null) return [];
  const lines = content.split(/\r\n?|\n/);
  const scriptsLine = Math.max(0, lines.findIndex((l) => l.includes('"scripts"')));
  return Object.entries(scripts).flatMap(([name, command]) => {
    if (typeof command !== "string") return [];
    const found = lines.findIndex((l, i) => i > scriptsLine && l.includes(`${JSON.stringify(name)}:`));
    const line = (found === -1 ? scriptsLine : found) + 1;
    const text = `${JSON.stringify(name)}: ${JSON.stringify(command)}`;
    return [{
      id: `${file}#scripts.${name}`,
      name: `scripts.${name}`,
      file,
      text,
      hash: contentHash(text),
      startLine: line,
      endLine: line,
      commands: runScript(files, name).map(normalise),
    }];
  });
}

/** One item per workflow step with a `run` key, read line by line rather than as YAML. */
function stepEvidence(file: string, content: string): SetupEvidence[] {
  const lines = content.split(/\r\n?|\n/);
  const steps: SetupEvidence[] = [];
  lines.forEach((line, i) => {
    const match = line.match(/^(\s*(?:-\s+)?)run:\s*(.*)$/);
    if (!match) return;
    const keyColumn = match[1]!.length;
    const value = match[2]!.trim();
    let commands: string[];
    let end = i;
    if (/^[|>][-+]?\d*$/.test(value)) {
      commands = [];
      while (end + 1 < lines.length) {
        const next = lines[end + 1]!;
        if (next.trim() !== "" && next.search(/\S/) <= keyColumn) break;
        end++;
        if (next.trim() !== "") commands.push(next.trim());
      }
    } else {
      commands = [value.replace(/^(["'])(.*)\1$/, "$2")];
    }
    commands = commands.filter((c) => c !== "" && !c.startsWith("#")).map(normalise);
    if (commands.length === 0) return;
    const text = commands.join("\n");
    steps.push({
      id: `${file}#step-${steps.length + 1}`,
      name: commands[0]!,
      file,
      text,
      hash: contentHash(text),
      startLine: i + 1,
      endLine: end + 1,
      commands,
    });
  });
  return steps;
}

const SHELL_LANGUAGES = new Set(["", "sh", "bash", "shell", "console", "zsh", "powershell", "ps1", "cmd"]);

/** One item per fenced shell block in a doc, its commands being the block's lines without prompts or comments. */
function docEvidence(file: string, content: string): SetupEvidence[] {
  const lines = content.split(/\r\n?|\n/);
  const blocks: SetupEvidence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i]!.match(/^\s*(`{3,}|~{3,})\s*([\w-]*)/);
    if (!open) continue;
    const fence = open[1]!;
    let end = i + 1;
    while (end < lines.length && !lines[end]!.trim().startsWith(fence)) end++;
    const body = lines.slice(i + 1, end);
    const start = i;
    i = end;
    if (!SHELL_LANGUAGES.has(open[2]!.toLowerCase())) continue;
    const commands = body
      .map((l) => l.trim().replace(/^(\$|>|PS>)\s+/, ""))
      .filter((c) => c !== "" && !c.startsWith("#"))
      .map(normalise);
    if (commands.length === 0) continue;
    const text = commands.join("\n");
    blocks.push({
      // A heading's slug never holds a dot, so this can't be the id of one of the doc's passages.
      id: `${file}#block.${blocks.length + 1}`,
      name: commands[0]!,
      file,
      text,
      hash: contentHash(text),
      startLine: start + 1,
      endLine: Math.min(end, lines.length - 1) + 1,
      commands,
    });
  }
  return blocks;
}
