# Claude only, with no LLM provider abstraction

Scribe calls Claude directly (Sonnet for writing, Haiku for bulk summarisation and verification) behind a thin internal interface that is deliberately not generalised to other providers. This is a learning project: a provider-agnostic layer would cost real effort to build and test without teaching anything the project is for. Revisit only if a second provider becomes a real need.
