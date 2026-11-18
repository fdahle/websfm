# WebSfM

@AGENTS.md
@CONTRIBUTING.md
@docs/conventions.md

Personal, machine-specific notes go in CLAUDE.local.md (gitignored).

Some folders have their own CLAUDE.md with that area's traps (`crates/`, `scripts/bench/`,
`src/stores/`, `src/workers/gpu/`); they load when you work there. When a trap costs a
run or an hour, add a line to the nearest one, short, with the fix rather than the story.

- A new model in `src/core/models/registry.js`: upload its file to the `models-v1` release
  (`gh release upload models-v1 public/models/<file>`) before pushing, or the deploy 404s.
- Never change a model file's bytes under the same name: pinned old versions (`/v/0.9.0/`)
  load the same `/models/<file>`. New weights get a new `file` name.
