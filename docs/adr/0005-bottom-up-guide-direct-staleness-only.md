# The Guide is built bottom-up, and staleness does not propagate upward

Module Sections are generated first from code Evidence; top-level Sections (Overview, Architecture) are written from the Module Sections plus the inter-Module import graph, rather than by agentic exploration or embedding retrieval. A top-level Section becomes Stale only when Evidence it cites directly changes (e.g. the import graph or root config), not whenever a Module Section it was built from is regenerated; otherwise every small change would ripple up and regenerate the top of the Guide on every `update`.
