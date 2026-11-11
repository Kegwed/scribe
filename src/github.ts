import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { contentHash } from "./hash.ts";
import { CACHE_DIR } from "./manifest.ts";
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

/** How many pull requests, with their linked issues, each Module Section is offered. */
export const PULL_REQUESTS_PER_MODULE = 5;
/** A pull request's rank halves for each year it was merged before the newest one. */
const RANK_HALF_LIFE_DAYS = 365;

/**
 * GitHub Evidence for each Module, keyed by Module path: the discussion on the
 * merged pull requests that touched its files, and the issues they link to,
 * from the highest-ranked pull requests only.
 */
export async function gitHubEvidence(repoDir: string, github: GitHub, modules: Module[]): Promise<Map<string, GitHubEvidence[]>> {
  const cached = cachedGitHub(repoDir, github);
  const merged = (await cached.pullRequests()).filter((pr) => pr.mergedAt !== null);
  const rank = ranking(merged);
  const chosen = new Map<string, PullRequestSummary[]>(modules.map((m) => [m.path, []]));
  for (const summary of merged) {
    for (const file of summary.files) {
      const pulls = chosen.get(moduleOf(file, modules)?.path ?? "");
      if (pulls && !pulls.includes(summary)) pulls.push(summary);
    }
  }

  const details = new Map<number, Promise<GitHubEvidence[]>>();
  const evidence = new Map<string, GitHubEvidence[]>();
  for (const [path, pulls] of chosen) {
    const top = pulls.sort((a, b) => rank(b) - rank(a) || b.number - a.number).slice(0, PULL_REQUESTS_PER_MODULE);
    for (const { number } of top) {
      if (!details.has(number)) details.set(number, cached.pullRequest(number).then(discussionOf));
    }
    evidence.set(path, (await Promise.all(top.map(({ number }) => details.get(number)!))).flat());
  }
  return evidence;
}

/**
 * `github` answering from the Target repo's cache where it can. The list is
 * cached per commit: a pull request merged since was merged upstream of the
 * code being documented. A pull request is cached until it is next updated.
 * Responses are cached only once validated, so a bad one is never replayed.
 */
function cachedGitHub(repoDir: string, github: GitHub): GitHub {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" });
  const sha = head.status === 0 ? head.stdout.trim() : undefined;
  const updatedAt = new Map<number, string>();

  async function cached<T>(name: string | undefined, fetch: () => Promise<T>, valid: (value: unknown) => boolean): Promise<T> {
    const file = name && join(repoDir, CACHE_DIR, "github", `${name}.json`);
    if (file && existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
    const value = await fetch();
    if (!valid(value)) throw new Error(`malformed GitHub response: ${JSON.stringify(value)}`);
    if (file) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value));
    }
    return value;
  }

  return {
    async pullRequests() {
      const list = await cached(sha && `pulls-${sha}`, () => github.pullRequests(), isSummaryList);
      for (const pr of list) updatedAt.set(pr.number, pr.updatedAt);
      return list;
    },
    pullRequest(number) {
      const version = updatedAt.get(number);
      const name = version === undefined ? undefined : `pull-${number}-${contentHash(version).slice(0, 16)}`;
      return cached(name, () => github.pullRequest(number), isPullRequest);
    },
  };
}

const isString = (v: unknown) => typeof v === "string";
const isNumber = (v: unknown) => typeof v === "number";

function isSummaryList(value: unknown): boolean {
  return Array.isArray(value) && value.every((pr) =>
    isNumber(pr?.number) && (pr.mergedAt === null || isString(pr.mergedAt)) && isString(pr.updatedAt) &&
    Array.isArray(pr.files) && pr.files.every(isString) && isNumber(pr.reviewComments));
}

function isPullRequest(pr: any): boolean {
  return isNumber(pr?.number) && isString(pr.title) && isString(pr.body) && isString(pr.url) &&
    Array.isArray(pr.comments) && pr.comments.every((c: any) => isNumber(c?.id) && isString(c.body) && isString(c.url)) &&
    Array.isArray(pr.linkedIssues) && pr.linkedIssues.every((i: any) => isNumber(i?.number) && isString(i.title) && isString(i.body) && isString(i.url));
}

/**
 * Ranks pull requests by review discussion, discounted by how long before the
 * newest of them each was merged. Measured from the newest rather than today,
 * so the ranking, and the prompts it feeds, don't change while nothing merges.
 */
function ranking(merged: PullRequestSummary[]): (pr: PullRequestSummary) => number {
  const time = (pr: PullRequestSummary) => Date.parse(pr.mergedAt!);
  const newest = Math.max(...merged.map(time));
  return (pr) => (1 + pr.reviewComments) * 0.5 ** ((newest - time(pr)) / (RANK_HALF_LIFE_DAYS * 86_400_000));
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
