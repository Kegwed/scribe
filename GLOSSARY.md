# Scribe

Scribe generates onboarding documentation for new contributors to a repository, grounded in its code, git history, and GitHub discussions, and keeps that documentation current as the repository changes.

## Language

**Target repo**:
The repository whose documentation Scribe generates and maintains.
_Avoid_: Project, codebase, input repo

**Guide**:
The complete onboarding documentation Scribe maintains for one Target repo.
_Avoid_: Docs, documentation set, output

**Section**:
One independently updatable part of a Guide, such as an architecture overview or a single module's page.
_Avoid_: Page, chapter, doc

**Module**:
A unit of a Target repo's structure that gets its own Section: a workspace package if the repo has workspaces, otherwise a top-level source directory, unless configured otherwise.
_Avoid_: Component, package (when meaning the general concept), service

**Stale**:
Said of a Section when Evidence it cites has changed since Scribe last wrote it.
_Avoid_: Outdated, out of sync

**Frozen**:
Said of a Section that a human has edited since Scribe last wrote it; Scribe will not overwrite a Frozen Section.
_Avoid_: Locked, pinned, human-owned

**Proposal**:
A regenerated version of a Frozen, Stale Section, written alongside it for a human to merge by hand.
_Avoid_: Suggestion, draft, patch

**Claim**:
A single statement in a Section, which must cite at least one piece of Evidence.
_Avoid_: Fact, assertion

**Unsupported Claim**:
A human-written Claim in an adopted Section for which no Evidence could be found; it is kept and reported, never deleted.
_Avoid_: Unverified claim, orphan claim

**Drift**:
A contradiction between a Target repo's existing docs and its code, reported with Evidence for both sides; the code is treated as correct.
_Avoid_: Conflict, inconsistency, doc rot

**Source**:
A kind of input Scribe reads from a Target repo: code, git history, GitHub pull requests and issues, or the repo's existing docs.
_Avoid_: Input, data source, integration

**Evidence**:
One concrete item drawn from a Source that backs a Claim, such as a code symbol, a commit, or a pull request comment.
_Avoid_: Reference, context, citation (a citation is the link from a Claim to its Evidence, not the Evidence itself)
