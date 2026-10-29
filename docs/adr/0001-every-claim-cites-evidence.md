# Every Claim Scribe writes must cite Evidence

LLM-written docs fail by being confidently wrong, so Scribe never writes a Claim without citing at least one piece of Evidence, and a second, cheaper model pass verifies each Claim against its Evidence before it lands. A Section that fails verification gets one repair attempt with the verifier's feedback; Claims still unconfirmed are removed and listed in the run report. Citations double as the dependency graph that drives staleness, so this rule is structural, not cosmetic.

## Consequences

Human-written text in an adopted Section may contain Unsupported Claims. These are kept and reported, never deleted: the rule constrains what Scribe *writes*, not what humans write.
