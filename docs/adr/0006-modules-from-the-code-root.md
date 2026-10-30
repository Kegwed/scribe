# Without workspaces, Modules come from the Code root, not the top-level directories

In a repo without workspaces, Scribe finds the Code root by descending from the repo root for as long as all Product code sits in one directory. Each subdirectory of the Code root becomes a Module, and the files directly in the Code root form one more Module. Taking top-level directories as Modules gives most single-package repos (`src/`, `test/`, `scripts/`) a single Module covering all their code. That leaves the Architecture Section with no import graph between Modules to describe (ADR-0005), and it turns tests and scripts into Modules of their own.

## Considered Options

- **Top-level directories**: rejected. It collapses one-root repos into a single Module.
- **Fixed names (`src/`, then `lib/`)**: rejected. It misses `server/` + `client/` layouts and roots nested one level down (`src/app/`), and the descent rule handles all of these without any special names.
- **The whole repo as one Module, split by config**: rejected. It leaves the zero-config Guide too thin.

## Consequences

Module boundaries set the names of the Section files and the keys in the Manifest, so changing this rule later renames Sections in existing Guides. Product code is told apart from tests, examples and tooling by conventional directory and file names. Repos that break those conventions correct it through Module overrides in config.
