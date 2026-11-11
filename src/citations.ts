import { spawnSync } from "node:child_process";
import { type Evidence, isRepoEvidence } from "./evidence.ts";
import { CHURN_DAYS, type ChurnEvidence, isChurnEvidence } from "./git-history.ts";
import { gitHubRepo } from "./github.ts";

/** Builds SHA-pinned URLs, or undefined unless `origin` points at GitHub. */
interface Permalinks {
  /** Lines of a file, such as Evidence in it, at their current range. */
  file(lines: { file: string; startLine: number; endLine: number }): string;
  /** The commits that changed a repo-relative path, up to the pinned commit. */
  history(path: string): string;
}

export function githubPermalinks(repoDir: string): Permalinks | undefined {
  const repo = gitHubRepo(repoDir);
  const sha = git(repoDir, "rev-parse", "HEAD");
  if (!repo || !sha) return undefined;
  const encode = (path: string) => path.split("/").map(encodeURIComponent).join("/");
  return {
    file: ({ file, startLine, endLine }) => {
      // GitHub renders markdown, and a rendered file has no line anchors unless shown plain.
      const plain = /\.mdx?$/i.test(file) ? "?plain=1" : "";
      return `https://github.com/${repo}/blob/${sha}/${encode(file)}${plain}#L${startLine}-L${endLine}`;
    },
    history: (path) => `https://github.com/${repo}/commits/${sha}${path === "." ? "" : `/${encode(path)}`}`,
  };
}

export function citation(evidence: Evidence, permalinks: Permalinks | undefined): string {
  if (isRepoEvidence(evidence)) {
    const { label, lines } = evidence;
    return permalinks && lines ? `[${label}](${permalinks.file(lines)})` : label;
  }
  if (evidence.kind === "github") return `[${evidence.label}](${evidence.url})`;
  const label = `${evidence.file} (${evidence.name})`;
  return permalinks ? `[${label}](${permalinks.file(evidence)})` : label;
}

export function historyCitation({ module }: ChurnEvidence, permalinks: Permalinks | undefined): string {
  const label = `git history of ${module === "." ? "the repo" : module} (${CHURN_DAYS} days)`;
  return permalinks ? `[${label}](${permalinks.history(module)})` : label;
}

/**
 * A Section's text, as `citingIds` gives it, without the churn Claim Scribe
 * wrote, which is last of its paragraphs and cited by its last footnote.
 */
export function withoutChurn(content: string): string {
  const blocks = content.replace(/\n$/, "").split("\n\n");
  const footnotes = blocks.at(-1)?.startsWith("[^") ? blocks.pop()!.split("\n") : [];
  const churn = footnotes.at(-1)?.match(/^\[\^(\d+)\]: (\S+)$/);
  if (!churn || !isChurnEvidence(churn[2]!)) return content;
  footnotes.pop();
  // Only the last paragraph: Scribe writes the churn Claim there, alone.
  if (blocks.at(-1)?.endsWith(`[^${churn[1]}]`)) blocks.pop();
  return [...blocks, ...(footnotes.length > 0 ? [footnotes.join("\n")] : [])].join("\n\n") + "\n";
}

/** `content` without the sentence `statement`, if given, wherever it stands; a paragraph it leaves empty goes too. */
export function withoutStatement(content: string, statement: string | undefined): string {
  if (statement === undefined) return content;
  const blocks = content.replace(/\n$/, "").split("\n\n").map((block) => block.split(statement).join("").replace(/ {2,}/g, " ").trim());
  return blocks.filter((block) => block !== "").join("\n\n") + "\n";
}

export function withoutPins(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/\]\(https:\/\/github\.com\/.*\)$/gm, "]");
}

/**
 * A Section's text with each footnote naming the id of the symbol it cites, so
 * the model can keep a Claim's evidence as it is. Footnote n cites `ids[n - 1]`,
 * the order Scribe recorded them in.
 */
export function citingIds(content: string, ids: string[]): string {
  return content.replace(/\r\n?/g, "\n").replace(/^\[\^(\d+)\]: .*$/gm, (line, n: string) => {
    const id = ids[Number(n) - 1];
    return id === undefined ? line : `[^${n}]: ${id}`;
  });
}

/** A permalink pins HEAD, so its line range is wrong if the cited file has uncommitted changes. */
export function uncommittedWarnings(repoDir: string, section: string, evidence: { file: string }[]): string[] {
  const files = [...new Set(evidence.map((s) => s.file))];
  if (files.length === 0) return [];
  const dirty = git(repoDir, "status", "--porcelain", "--", ...files);
  if (!dirty) return [];
  const listed = files.filter((file) => dirty.includes(file));
  return [`${section} cites uncommitted changes in ${listed.join(", ")}; commit them and re-run, or its permalinks won't match.`];
}

/** The command's trimmed output, or undefined if it failed. */
function git(repoDir: string, ...args: string[]): string | undefined {
  const { status, stdout } = spawnSync("git", args, { cwd: repoDir, encoding: "utf8" });
  return status === 0 ? stdout.trim() : undefined;
}

/** A Section's prose without its footnote markers and footnotes. */
export function withoutCitations(content: string): string {
  return content.replace(/\r\n?/g, "\n").replace(/^\[\^\d+\]: .*\n?/gm, "").replace(/\[\^\d+\]/g, "").trimEnd() + "\n";
}
