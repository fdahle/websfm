# Notes for agents: the bench

[README.md](README.md) is the reference (config keys, stages, accuracy checks, *Linux:
reaching the GPU*). The traps below each cost a run before they were written down.

- Start a multi-minute run with the shell tool's background mode and wait for its exit
  notice. Never wait with `until ! pgrep -f X` or `while pgrep -f X`: the loop's own
  command line matches. `pgrep` takes an extended regex (`"a|b"`, not `"a\|b"`).
- `pkill -f <pattern>` kills the shell running it when the pattern is on its command
  line. Kill by pid, and the whole tree (node → Vite → Chrome).
- Two runs at once need their own `"port"`. A kept `profile` reopens only on the port
  that saved it (OPFS is per origin). Avoid ports Fetch blocks (4190 is one).
- Keep `out` and `profile` off `/tmp` (a tmpfs: runs die with QuotaExceededError). Never
  delete a profile after an ABORTED stage: it is the only way to resume.
- Runs use the GPU by default. Before quoting a timing, check the log's
  `backend = WebGPU (…)` line: a run that fell back to SwiftShader is slow without error.
- From a git worktree, symlink the gitignored `public/models` in, and never `git add -A`
  there (the symlink gets committed and replaces the real folder on merge).
- Don't edit `src/` or `package.json` while a bench or Playwright suite runs: Vite reloads
  the page, or re-optimizes its dependencies and a page gets two Pinias ("no active
  Pinia"), and the failures are false. Rerun a failure on a settled tree.
- Store runs take run units, not dialog units: build settings with `core/runSettings.js`
  (`{ ...ORTHO_DEFAULTS }` passed straight to a run gives an empty orthophoto).
- Headed Chrome with `--enable-features=Vulkan` (the bench's GPU flag) reads a GPU-backed
  canvas back all black: a profile built before 2026-11-18 has black thumbnails (rebuild it).
  Any canvas the app encodes or reads must be CPU-backed (`utils/canvasReadback.test.js`).
