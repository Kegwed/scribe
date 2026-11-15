# Scribe

Scribe writes onboarding documentation for a TypeScript or JavaScript repository and keeps it current as the code changes.

It reads the repository's code, its git history, its GitHub pull requests and issues, and its existing docs, and writes a **Guide**: one Markdown **Section** per **Module**, plus Getting started, Conventions, Key decisions, Overview and Architecture Sections. Every **Claim** in a Section cites the **Evidence** it rests on, such as a code symbol, a commit or a pull request comment, with a permalink, and a second model checks each Claim against its Evidence before it is written. Claims that can't be backed are dropped and listed.

Scribe records what it wrote and what each Section cites in a **Manifest**. When cited Evidence changes, the Section is **Stale**, and `scribe update` rewrites only the Stale Sections. Sections people have edited are never overwritten.

## Requirements

- Node 24 or later
- git
- optionally, the [GitHub CLI](https://cli.github.com/) (`gh`), signed in with `gh auth login`, so that Scribe can cite pull requests and issues. Without it, or when `origin` isn't on GitHub, Scribe says so in one line and carries on without GitHub Evidence.
- a TypeScript or JavaScript **Target repo**, as a git checkout
- a Claude API key in the `ANTHROPIC_API_KEY` environment variable. Scribe reads the key only from the environment. Create one in the [Anthropic Console](https://console.anthropic.com/settings/keys).

## Quickstart

From the root of your repository:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."
npx @kegwed/scribe init
npx @kegwed/scribe generate
npx @kegwed/scribe status
```

`init` lists the Modules it found and writes `scribe.config.json` and `.scribe/manifest.json`. `generate` prints its estimated cost and asks before calling Claude; it writes the Guide to `docs/guide/`. `status` reports which Sections need attention. Commit the Guide, the config and the Manifest. Later, after the code has changed:

```sh
npx @kegwed/scribe update
```

Once the package is installed (`npm install --save-dev @kegwed/scribe` or `npm install --global @kegwed/scribe`), the command is called `scribe`.

## Commands

Run every command from the root of the Target repo.

| Command | What it does |
| --- | --- |
| `scribe init` | Detects the Modules and writes `scribe.config.json` and the Manifest. Each workspace package is a Module; in a repo without workspaces, each subdirectory of the **Code root** is one, plus the files directly in it. To choose them yourself, set `"modules"` in `scribe.config.json` to a list of `{ "name", "path" }`. `guideDir` (default `docs/guide`) sets where the Guide goes. `init` git-ignores Scribe's response cache in `.scribe/cache/`. |
| `scribe generate` | Writes a cited Section for each Module, then Getting started, Conventions, Key decisions, Overview and Architecture. Overview and Architecture are written from the Module Sections and the import graph between Modules. Frozen Sections are left as they are. |
| `scribe update` | Rewrites each Stale Section, keeping the text its changed Evidence doesn't affect. Writes a Section for each added Module, reports each removed one, and writes a Proposal for each Section that is Frozen and Stale. |
| `scribe status` | Reports Stale, Frozen and missing Sections, added and removed Modules, Proposals waiting to be merged, Unsupported Claims, and Drift between the existing docs and the code. It makes no network calls and needs no key. It exits 1 when something needs `update` or a person (a Stale, missing, added or removed Section, or a Proposal), and 0 when only Frozen Sections, Unsupported Claims or Drift are reported, so it can gate CI. |
| `scribe adopt <section>` | Takes a Frozen Section's text, as a person left it, as the new baseline, so it is no longer Frozen. Scribe finds Evidence for each of its Claims and records the ones it can't back as Unsupported Claims. The text itself is never changed. |
| `scribe reset <section>` | Throws away a person's edits to a Section and writes it afresh from the code. |

Sections are named as `status` lists them, such as `modules/src-core` or `overview`.

`generate`, `update`, `adopt` and `reset` call Claude. They need `ANTHROPIC_API_KEY`, show an estimate and ask before spending anything. `init` and `status` never call Claude and need no key.

## Stale, Frozen and Proposals

**Stale.** A Section is Stale when code, git-history or existing-docs Evidence it cites has changed since Scribe last wrote it. Code Evidence is a symbol, hashed by that symbol's text, so an unrelated edit elsewhere in the file, such as an added import, doesn't make a Section Stale. Overview and Architecture are Stale only when Evidence they cite directly changes, not whenever a Module Section they were built from is rewritten. GitHub Evidence never makes a Section Stale: a pull request or issue is taken as fixed when it is cited. `update` rewrites Stale Sections.

**Frozen.** A Section is Frozen when a person has edited it since Scribe last wrote it. Scribe never overwrites a Frozen Section. Edit the Guide freely: your words stay yours.

**Proposals.** When a Section is both Frozen and Stale, `update` writes a **Proposal** beside it, `<section>.proposal.md`, holding the Section as Scribe would now write it. Merge what you want from it into the Section by hand, then delete the Proposal. After that you choose what the Section becomes:

- `scribe adopt <section>` makes your text the new baseline. Its Claims get Evidence where Scribe can find it, the rest are kept and reported as Unsupported Claims, and the Section is no longer Frozen, so it will become Stale again when its Evidence changes.
- `scribe reset <section>` discards your edits and lets Scribe write the Section again.

Either one deletes a pending Proposal for that Section.

**Drift.** When the repo's existing docs contradict its code, Scribe reports the Drift with Evidence for both sides and treats the code as correct.

## Costs

Every command that calls Claude first prints an estimate, per Section, of the dollars and tokens it will spend, and asks `Continue? [y/N]`. Anything but `y` stops it: nothing is spent and nothing is written. `--yes` (or `-y`) skips asking, for scripts and CI. Responses are cached in `.scribe/cache/`, so rerunning after an interruption doesn't pay twice, and a run with nothing to do doesn't ask at all.

Sonnet writes the Sections; Haiku summarises code that doesn't fit in one request and verifies every Claim. You can choose other models with `"models"` in `scribe.config.json`.

### Measured on hono

These figures come from one run each on [honojs/hono](https://github.com/honojs/hono): 9 Modules (the root `hono` package and 8 adapters), so 14 Sections in all. The GitHub Source was on and the default models were used. `generate` ran at [`61f7c59e`](https://github.com/honojs/hono/commit/61f7c59e50244ab4d2dd83c151928cf7ea448510) (4.13.17). `update` ran at [`f6fbaf02`](https://github.com/honojs/hono/commit/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823) (4.13.18), where `modules/root`, `overview` and `architecture` were Stale.

| Run | Estimate shown | Actually spent |
| --- | --- | --- |
| first `generate` | $0.71, about 844,799 tokens | $2.34, 2,286,385 tokens |
| `update` after one release | $0.35, about 469,038 tokens | $0.61, 745,233 tokens |

"Actually spent" is the token usage Claude reported for every request, priced at Anthropic's published rates. **The estimate currently runs low**: it was about a third of the real cost for this `generate`, and about 60% of it for this `update`. Budget for a first `generate` to cost about three times its estimate.

## Example

An excerpt from the Section Scribe wrote for hono's `@hono/vercel` adapter in the measured `generate` run, copied verbatim with its citations. It shows the heading, the second and third paragraphs, and the footnotes they cite; the rest of the Section is left out. Each footnote is a permalink to the Evidence, pinned to the commit Scribe read.

```markdown
# @hono/vercel

`handle` takes a Hono app and returns a function that accepts a standard `Request` and returns a `Response` or a promise of one.[^2] The returned function simply calls `app.fetch(req)`, so it adds no extra routing or processing of its own.[^2]

`getConnInfo` is typed as Hono's `GetConnInfo` and, given a context, returns an object with a `remote` field.[^3] The remote address is read from the `x-real-ip` request header. A code comment next to it links to Vercel's edge-headers source as the reference for that header.[^3]

[^2]: [adapters/vercel/src/handler.ts (handle)](https://github.com/honojs/hono/blob/61f7c59e50244ab4d2dd83c151928cf7ea448510/adapters/vercel/src/handler.ts#L4-L8)
[^3]: [adapters/vercel/src/conninfo.ts (getConnInfo)](https://github.com/honojs/hono/blob/61f7c59e50244ab4d2dd83c151928cf7ea448510/adapters/vercel/src/conninfo.ts#L3-L8)
```

The rest of that Section cites hono's README, a pull request and the adapter's git history in the same way.

The excerpt describes [hono](https://github.com/honojs/hono), copyright (c) 2021 - present, Yusuke Wada and Hono contributors, and cites its code, which is released under the [MIT Licence](https://github.com/honojs/hono/blob/61f7c59e50244ab4d2dd83c151928cf7ea448510/LICENSE). Scribe is not affiliated with hono.

## Limitations

- **TypeScript and JavaScript only.** Scribe reads code through the TypeScript compiler, so it supports TypeScript and JavaScript Target repos and no other languages.
- **Claude only.** Scribe calls Claude directly and has no layer for other LLM providers ([ADR-0003](docs/adr/0003-claude-only-no-provider-abstraction.md)).
- **GitHub Evidence never makes a Section Stale.** A cited pull request, comment or issue is not re-fetched, so an edited or deleted comment can leave a Claim citing Evidence that no longer matches GitHub until something else makes the Section Stale or you run `scribe reset` ([ADR-0007](docs/adr/0007-github-evidence-never-makes-a-section-stale.md)).
- Scribe is at 0.x: its commands and files may still change before 1.0.

## Further reading

- [GLOSSARY.md](GLOSSARY.md) defines the terms this README uses: Target repo, Guide, Section, Module, Claim, Evidence, Stale, Frozen, Proposal and the rest.
- [docs/adr/](docs/adr/) holds the decisions behind Scribe's design, one per file.
- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to report issues and work on Scribe, and [SECURITY.md](SECURITY.md) how to report a vulnerability.

## Licence

Scribe is released under the [MIT Licence](LICENSE), © Kegwed.
