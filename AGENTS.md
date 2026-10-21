# Notes for AI coding agents

websfm is a browser photogrammetry app: Vue 3 + Pinia UI, a web-worker pool, and
Rust compiled to WebAssembly. Read these before changing code:

- [ARCHITECTURE.md](ARCHITECTURE.md): the layers, and which files a change touches.
- [CONTRIBUTING.md](CONTRIBUTING.md): what a change needs, including **Keep the
  in-app help in step**, which applies to every change to a setting, operation or
  user-visible feature.
- [docs/METHODS.md](docs/METHODS.md): the algorithms, when a change touches the maths.

Rules that are easy to miss:

- `src/core/` is pure: no Vue, Pinia, OPFS or DOM. Plain data in, plain data out.
- User-facing defaults live in `src/core/defaults.user.js`, internal tuning in
  `src/core/tuning.js`; nothing else hard-codes them.
- After a change under `crates/`, run `npm run build:wasm` and commit `src/wasm/`
  with it.
- Run `npm test` and `npm run typecheck` before calling a change done.
- In the final summary, say which help files (`src/guide/`, `src/glossary/`) were
  updated, or that none needed it.
