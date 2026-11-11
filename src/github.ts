import { contentHash } from "./hash.ts";
import { type Module, moduleOf } from "./modules.ts";

/** One item of GitHub discussion a Claim can cite: a pull request's description, a review comment, or a linked issue. */
export interface GitHubEvidence {
  /** `github:pr/<n>`, `github:pr/<n>/comment/<id>` or `github:issue/<n>`. */
  id: string;
  /** How a citation names it, such as "PR #12, review comment". */
  label: string;
  url: string;
  text: string;
  /** Hash of `text`. */
  hash: string;
}

const GITHUB_EVIDENCE = "github:";

export function isGitHubEvidence(id: string): boolean {
  return id.startsWith(GITHUB_EVIDENCE);
}

/** GitHub Evidence for each Module, keyed by Module path, from the merged pull requests that touched its files. */
export async function gitHubEvidence(github: GitHub, modules: Module[]): Promise<Map<string, GitHubEvidence[]>> {
  const evidence = new Map<string, GitHubEvidence[]>(modules.map((m) => [m.path, []]));
  for (const summary of await github.pullRequests()) {
    if (summary.mergedAt === null) continue;
    const touched = new Set(summary.files.flatMap((file) => moduleOf(file, modules)?.path ?? []));
    if (touched.size === 0) continue;
    const items = discussionOf(await github.pullRequest(summary.number));
    for (const path of touched) evidence.get(path)!.push(...items);
  }
  return evidence;
}

function discussionOf(pr: PullRequest): GitHubEvidence[] {
  const item = (id: string, label: string, url: string, text: string) => ({ id: `${GITHUB_EVIDENCE}${id}`, label, url, text, hash: contentHash(text) });
  return [
    item(`pr/${pr.number}`, `PR #${pr.number}`, pr.url, `${pr.title}\n\n${pr.body}`.trim()),
    ...pr.comments.map((c) => item(`pr/${pr.number}/comment/${c.id}`, `PR #${pr.number}, review comment`, c.url, c.body)),
    ...pr.linkedIssues.map((i) => item(`issue/${i.number}`, `Issue #${i.number}`, i.url, `${i.title}\n\n${i.body}`.trim())),
  ];
}

/** A pull request as listed, with what Scribe needs to choose among them. */
export interface PullRequestSummary {
  number: number;
  /** ISO 8601; null unless the pull request was merged. */
  mergedAt: string | null;
  /** ISO 8601; changes whenever anything on the pull request does. */
  updatedAt: string;
  /** Repo-relative paths the pull request touched. */
  files: string[];
  /** Review comments across its review threads: its discussion volume. */
  reviewComments: number;
}

export interface ReviewComment {
  id: number;
  body: string;
  url: string;
}

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}

/** A pull request's discussion: its description, review threads and the issues it links to. */
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  comments: ReviewComment[];
  linkedIssues: LinkedIssue[];
}

/** The Target repo's pull requests and issues on GitHub. */
export interface GitHub {
  /** Its pull requests, merged and otherwise. */
  pullRequests(): Promise<PullRequestSummary[]>;
  pullRequest(number: number): Promise<PullRequest>;
}
