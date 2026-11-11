import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodeSymbol } from "./analyser.ts";
import { contentHash } from "./hash.ts";
import type { Module } from "./modules.ts";
import type { FileEvidence } from "./section-writer.ts";

/**
 * One heading's part of an existing doc in the Target repo, such as the README
 * or an ADR: the unit doc Evidence is anchored to and hashed by. Doc comments
 * need no entry here; they are part of the code symbol they document.
 */
export interface DocEvidence extends FileEvidence {
  kind: "doc";
  /** `<file>#<heading slug>`, or just `<file>` for the text before its first heading. */
  id: string;
  /** The heading, or the file's name for the text before its first heading. */
  name: string;
  /** The heading and the text under it up to the next heading, line endings normalised. */
  text: string;
}

const DOC_FILE = /\.mdx?$/i;
const NAMED_DOC = /^(?:readme|contributing)(?:\.[^/]*)?\.mdx?$/i;
const DECISION_DIRS = new Set(["adr", "adrs", "decisions"]);

/**
 * The Target repo's existing docs, split at their headings: every README and
 * CONTRIBUTING file, and the ADRs. Scribe reads them and never writes them;
 * its own Guide, under `guideDir`, is never one of them.
 */
export async function readDocs(repoDir: string, guideDir: string): Promise<DocEvidence[]> {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoDir,
    encoding: "utf8",
  }).split("\0").filter((file) => isExistingDoc(file, guideDir)).sort();
  const docs: DocEvidence[] = [];
  for (const file of files) docs.push(...passages(file, await readFile(join(repoDir, file), "utf8")));
  return docs;
}

function isExistingDoc(file: string, guideDir: string): boolean {
  if (!DOC_FILE.test(file) || file.startsWith(`${guideDir.replace(/\/$/, "")}/`)) return false;
  const segments = file.split("/");
  if (segments.some((s) => s.startsWith(".") || s === "node_modules")) return false;
  return NAMED_DOC.test(segments.at(-1)!) || inDecisionDir(segments);
}

/** Whether a passage is from an ADR: a doc in an `adr`, `adrs` or `decisions` directory. */
export function isDecisionRecord({ file }: DocEvidence): boolean {
  return inDecisionDir(file.split("/"));
}

function inDecisionDir(segments: string[]): boolean {
  return segments.slice(0, -1).some((s) => DECISION_DIRS.has(s.toLowerCase()));
}

/** The doc's passages, one per heading, plus one for any text before the first. */
function passages(file: string, content: string): DocEvidence[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const starts: { line: number; heading?: string }[] = [{ line: 0 }];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1];
    if (marker && (fence === undefined || marker.startsWith(fence))) {
      fence = fence === undefined ? marker : undefined;
      return;
    }
    const heading = fence === undefined ? line.match(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/)?.[1] : undefined;
    if (heading !== undefined) starts.push({ line: i, heading });
  });

  const slugs = new Map<string, number>();
  const result: DocEvidence[] = [];
  starts.forEach(({ line, heading }, i) => {
    const end = (starts[i + 1]?.line ?? lines.length) - 1;
    let last = end;
    while (last >= line && lines[last]!.trim() === "") last--;
    if (last < line) return;
    const text = lines.slice(line, last + 1).join("\n");
    let id = file;
    if (heading !== undefined) {
      const slug = slugOf(heading);
      const seen = slugs.get(slug) ?? 0;
      slugs.set(slug, seen + 1);
      id = `${file}#${seen === 0 ? slug : `${slug}-${seen}`}`;
    }
    result.push({
      kind: "doc",
      id,
      name: heading ?? file.split("/").at(-1)!,
      file,
      text,
      hash: contentHash(text),
      startLine: line + 1,
      endLine: last + 1,
    });
  });
  return result;
}

/** The anchor GitHub gives a heading. */
function slugOf(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
}

/** The passages that concern a Module: those naming its directory or a symbol it exports. */
export function docsAbout(module: Module, symbols: CodeSymbol[], docs: DocEvidence[]): DocEvidence[] {
  const names = new Set(symbols.filter((s) => s.module === module.path).flatMap((s) => s.exportedAs).filter((n) => n !== "default"));
  return docs.filter(({ text }) =>
    (module.path !== "." && text.includes(module.path)) ||
    [...names].some((name) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(text)),
  );
}
