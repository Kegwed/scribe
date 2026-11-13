# GitHub Evidence never makes a Section Stale

A pull request, PR comment or issue that a Claim cites is taken as fixed when it is cited. Neither `status` nor `update` re-fetches it to check for edits. `status` must make no network calls, so it could never see such an edit. Making `update` alone check would mean re-fetching every cited item from GitHub on every run, spending rate limit and time, to catch edits that rarely happen: discussion on a merged pull request almost never changes in substance.

## Considered Options

- **`update` re-fetches cited GitHub Evidence and compares hashes, and `status` reports that it cannot tell**: rejected because it costs network time and rate limit on every `update`, and leaves `status` and `update` disagreeing about which Sections are Stale.

## Consequences

An edited or deleted GitHub comment can leave a Claim citing outdated text until something else makes the Section Stale, or until `scribe reset` regenerates it.
