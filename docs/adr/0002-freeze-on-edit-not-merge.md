# Human edits freeze a whole Section rather than being merged

A Section a human has edited since Scribe last wrote it (detected by hash against the manifest) becomes Frozen: Scribe never overwrites it. If it is also Stale, Scribe writes a Proposal alongside it for a human to merge by hand. `scribe adopt` takes the human text as the new baseline; `scribe reset` discards it.

## Considered Options

- **Fenced regions** (`<!-- scribe:begin/end -->` markers): rejected as clutter that humans edit inside anyway.
- **LLM three-way merge**: rejected because a silent merge that drops or rewrites human words destroys trust in the Guide.

## Consequences

One Section per markdown file, so freeze boundaries are unambiguous.
