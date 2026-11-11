import type { GitHub, LinkedIssue, PullRequest, PullRequestSummary } from "../github.ts";

/** A canned pull request; unset fields default to a merged one with no discussion. */
export interface CannedPullRequest {
  number: number;
  mergedAt?: string | null;
  updatedAt?: string;
  files: string[];
  title?: string;
  body?: string;
  /** Review comment bodies; comment n of PR p gets the id p * 100 + n. */
  comments?: string[];
  linkedIssues?: Omit<LinkedIssue, "url">[];
}

export interface FakeGitHub extends GitHub {
  /** Every call that reached this adapter, which a cache hit never does. */
  calls: string[];
}

/** A GitHub with the given pull requests, at https://github.com/acme/app. */
export function fakeGitHub(pulls: CannedPullRequest[]): FakeGitHub {
  const calls: string[] = [];
  const detail = (p: CannedPullRequest): PullRequest => ({
    number: p.number,
    title: p.title ?? `PR ${p.number}`,
    body: p.body ?? "",
    url: `https://github.com/acme/app/pull/${p.number}`,
    comments: (p.comments ?? []).map((body, i) => {
      const id = p.number * 100 + i + 1;
      return { id, body, url: `https://github.com/acme/app/pull/${p.number}#discussion_r${id}` };
    }),
    linkedIssues: (p.linkedIssues ?? []).map((issue) => ({ ...issue, url: `https://github.com/acme/app/issues/${issue.number}` })),
  });
  return {
    calls,
    async pullRequests(): Promise<PullRequestSummary[]> {
      calls.push("pullRequests");
      return pulls.map((p) => ({
        number: p.number,
        mergedAt: p.mergedAt === undefined ? "2026-01-01T00:00:00Z" : p.mergedAt,
        updatedAt: p.updatedAt ?? "2026-01-02T00:00:00Z",
        files: p.files,
        reviewComments: (p.comments ?? []).length,
      }));
    },
    async pullRequest(number) {
      calls.push(`pullRequest ${number}`);
      const p = pulls.find((p) => p.number === number);
      if (!p) throw new Error(`no pull request ${number}`);
      return detail(p);
    },
  };
}
