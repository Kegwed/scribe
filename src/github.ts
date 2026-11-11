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
/** How many of the repo's highest-ranked pull requests, with their linked issues, Key decisions is offered. */
export const PULL_REQUESTS_FOR_DECISIONS = 10;
/** A pull request's rank halves for each year it was merged before the newest one. */
const RANK_HALF_LIFE_DAYS = 365;

/** The GitHub Evidence the Sections draw on. */
export interface Discussions {
  /** Each Module's, keyed by Module path. */
  byModule: Map<string, GitHubEvidence[]>;
  /** Key decisions'. */
  decisions: GitHubEvidence[];
}

export const NO_DISCUSSIONS: Discussions = { byModule: new Map(), decisions: [] };

/** GitHub Evidence fetched for a run, with what GitHub answered not yet in the Target repo's cache. */
export interface FetchedDiscussions {
  discussions: Discussions;
  /** Writes GitHub's validated answers to the cache; a run calls it only once it goes ahead, so a declined run changes no files. */
  saveCache(): Promise<void>;
}

/**
 * GitHub Evidence for each Module: the discussion on the merged pull requests
 * that touched its files, and the issues they link to, from the
 * highest-ranked pull requests only. There is none without `github`. If
 * GitHub fails, there is none either, and `warnings` says why, so Scribe
 * carries on with its other Sources.
 */
export async function gitHubEvidence(
  repoDir: string,
  github: GitHub | undefined,
  modules: Module[],
  warnings: string[],
): Promise<FetchedDiscussions> {
  if (!github) return { discussions: NO_DISCUSSIONS, saveCache: async () => {} };
  const cached = cachedGitHub(repoDir, github);
  try {
    return { discussions: await rankedEvidence(cached, modules), saveCache: cached.save };
  } catch (error) {
    warnings.push(`GitHub skipped, so no pull requests or issues are cited: ${error instanceof Error ? error.message : String(error)}`);
    return { discussions: NO_DISCUSSIONS, saveCache: cached.save };
  }
}

async function rankedEvidence(cached: GitHub, modules: Module[]): Promise<Discussions> {
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
  const discussionOfTop = async (pulls: PullRequestSummary[], count: number) => {
    const top = [...pulls].sort((a, b) => rank(b) - rank(a) || b.number - a.number).slice(0, count);
    for (const { number } of top) {
      if (!details.has(number)) details.set(number, cached.pullRequest(number).then(discussionOf));
    }
    return (await Promise.all(top.map(({ number }) => details.get(number)!))).flat();
  };
  const byModule = new Map<string, GitHubEvidence[]>();
  for (const [path, pulls] of chosen) byModule.set(path, await discussionOfTop(pulls, PULL_REQUESTS_PER_MODULE));
  // Whichever files they touched: a decision can concern the whole repo.
  return { byModule, decisions: await discussionOfTop(merged, PULL_REQUESTS_FOR_DECISIONS) };
}

/**
 * `github` answering from the Target repo's cache where it can. The list is
 * cached per commit: a pull request merged since was merged upstream of the
 * code being documented. A pull request is cached until it is next updated.
 * Responses are cached only once validated, so a bad one is never replayed,
 * and only when `save` is called.
 */
function cachedGitHub(repoDir: string, github: GitHub): GitHub & { save(): Promise<void> } {
  const sha = git(repoDir, "rev-parse", "HEAD");
  const updatedAt = new Map<number, string>();
  const unsaved = new Map<string, unknown>();

  async function cached<T>(name: string | undefined, fetch: () => Promise<T>, valid: (value: unknown) => boolean): Promise<T> {
    const file = name && join(repoDir, CACHE_DIR, "github", `${name}.json`);
    if (file && unsaved.has(file)) return unsaved.get(file) as T;
    if (file && existsSync(file)) return JSON.parse(await readFile(file, "utf8"));
    const value = await fetch();
    if (!valid(value)) throw new Error(`malformed GitHub response: ${JSON.stringify(value)}`);
    if (file) unsaved.set(file, value);
    return value;
  }

  return {
    async save() {
      for (const [file, value] of unsaved) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify(value));
      }
      unsaved.clear();
    },
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
  const item = (id: string, label: string, url: string, raw: string) => {
    const text = withoutPeople(raw);
    return { id: `${GITHUB_EVIDENCE}${id}`, label, url, text, hash: contentHash(text) };
  };
  return [
    item(`pr/${pr.number}`, `PR #${pr.number}`, pr.url, `${pr.title}\n\n${pr.body}`.trim()),
    ...pr.comments.map((c) => item(`pr/${pr.number}/comment/${c.id}`, `PR #${pr.number}, review comment`, c.url, c.body)),
    ...pr.linkedIssues.map((i) => item(`issue/${i.number}`, `Issue #${i.number}`, i.url, `${i.title}\n\n${i.body}`.trim())),
  ];
}

/**
 * GitHub text with the people it names taken out before any prompt sees it,
 * so a Section can't name them whatever the model does: @mentions read
 * "someone", email addresses "an email address", and trailer lines such as
 * Co-authored-by are dropped. Code spans and blocks are kept as they are, and
 * so is an @ followed by a slash, which names a package scope or a team.
 */
function withoutPeople(text: string): string {
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
    .map((part, i) => i % 2 === 1 ? part : part
      .replace(/^[ \t]*(?:Co-authored-by|Signed-off-by|Reviewed-by|Reported-by|Acked-by|Tested-by):.*(?:\r?\n|$)/gim, "")
      .replace(/[\w.+-]+@[A-Za-z\d-]+(?:\.[A-Za-z\d-]+)+/g, "an email address")
      .replace(/(?<![\w@./`])@[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}(?![\w/-])/g, "someone"))
    .join("")
    .trim();
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
  /** Its pull requests; any not merged are ignored, so an adapter may leave them out. */
  pullRequests(): Promise<PullRequestSummary[]>;
  pullRequest(number: number): Promise<PullRequest>;
}

/** `owner/name` of the GitHub repo `origin` points at, or undefined if it isn't on GitHub. */
export function gitHubRepo(repoDir: string): string | undefined {
  const origin = git(repoDir, "remote", "get-url", "origin");
  return origin?.match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/)?.[1];
}

/** The token `gh` is signed in with, or undefined if it isn't installed or signed in. */
export function ghAuthToken(): string | undefined {
  return run("gh", ["auth", "token"], ".");
}

/**
 * The GitHub adapter for the Target repo: undefined unless `origin` points at
 * GitHub and `token` gives one, in which case Scribe uses its other Sources only.
 */
export function connectGitHub(repoDir: string, token: () => string | undefined = ghAuthToken): GitHub | undefined {
  const repo = gitHubRepo(repoDir);
  if (!repo) return undefined;
  const secret = token();
  if (!secret) return undefined;
  const [owner, name] = repo.split("/");
  const query = (text: string, variables: Record<string, unknown>) =>
    graphql(secret, text, { owner, name, ...variables }) as Promise<any>;

  return {
    async pullRequests() {
      const pulls: PullRequestSummary[] = [];
      let after: string | null = null;
      do {
        const { repository } = await query(LIST_QUERY, { after });
        const page: any = repository.pullRequests;
        for (const pr of page.nodes) {
          pulls.push({
            number: pr.number,
            mergedAt: pr.mergedAt,
            updatedAt: pr.updatedAt,
            files: pr.files?.nodes.map((f: any) => f.path) ?? [],
            reviewComments: pr.reviewThreads.nodes.reduce((sum: number, t: any) => sum + t.comments.totalCount, 0),
          });
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after && pulls.length < MAX_PULL_REQUESTS_LISTED);
      return pulls;
    },
    async pullRequest(number) {
      const { repository: { pullRequest: pr } } = await query(PULL_QUERY, { number });
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        url: pr.url,
        comments: pr.reviewThreads.nodes.flatMap((t: any) =>
          t.comments.nodes.map((c: any) => ({ id: c.databaseId, body: c.body, url: c.url }))),
        linkedIssues: pr.closingIssuesReferences.nodes.map((i: any) => ({ number: i.number, title: i.title, body: i.body, url: i.url })),
      };
    },
  };
}

/** The most recently updated merged pull requests are listed, up to this many. */
const MAX_PULL_REQUESTS_LISTED = 1000;

const LIST_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number mergedAt updatedAt
        files(first: 100) { nodes { path } }
        reviewThreads(first: 100) { nodes { comments { totalCount } } }
      }
    }
  }
}`;

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title body url
      reviewThreads(first: 100) { nodes { comments(first: 50) { nodes { databaseId body url } } } }
      closingIssuesReferences(first: 10) { nodes { number title body url } }
    }
  }
}`;

async function graphql(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "scribe" },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  const { data, errors } = (await response.json()) as { data?: unknown; errors?: { message: string }[] };
  if (errors?.length) throw new Error(`GitHub: ${errors.map((e) => e.message).join("; ")}`);
  return data;
}

/** The command's trimmed output, or undefined if it failed. */
function run(command: string, args: string[], cwd: string): string | undefined {
  const { status, stdout } = spawnSync(command, args, { cwd, encoding: "utf8" });
  return status === 0 ? stdout.trim() || undefined : undefined;
}

function git(repoDir: string, ...args: string[]): string | undefined {
  return run("git", args, repoDir);
}
