# Notes for AI coding agents

WebSfM is a browser photogrammetry app: Vue 3 + Pinia UI, a web-worker pool, and
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
- Use every core for heavy CPU work. Spread independent items (images, pairs, maps,
  blocks) over the worker pool (`POOL_SIZE`, `worker:` pins a call; split as in
  `core/dense/depthSplit.js`, each worker with its share of the memory budget), or run
  inner loops on the threaded WASM build (rayon, `src/wasm/reconstruction-mt`). One
  worker is right only where it is measured to be faster (a GPU path; fusion, which is
  bound by reads): say so in a comment. Log how many workers a run used.
- A dialog that runs a processing step shows its settings as numbered `SettingsStep`s
  in run order, each with a live effect line from `src/core/stepEffects/`
  ([CONTRIBUTING.md](CONTRIBUTING.md) ▸ *Dialogs of a processing step*).
- Keyboard shortcuts live in `src/core/help/shortcuts.js`: a handler tests
  `matches(e, id)` and a tooltip shows `keyLabel(id)`; never compare `e.key` or type
  "(Ctrl+Z)" by hand ([CONTRIBUTING.md](CONTRIBUTING.md) ▸ *Keep the in-app help in
  step*, item 4).
- A user-visible change gets a CHANGELOG.md entry under `[Unreleased]`: a bold
  headline, then one sentence in user terms, then any detail and evidence (Help ▸
  What's New shows the first two alone). Never edit a released section or the version
  by hand; `npm run release` cuts a release.
- Pushing deploys: `main` goes to dev.websfm.app, a `v*` tag to websfm.app (CI ▸
  `deploy`). Don't push, and never push a tag, unless asked.
- The name is **WebSfM** in anything people read (UI text, messages, docs, help).
  Lowercase `websfm` stays only in identifiers: URLs, the repo and npm package, the
  `.websfm` extension, storage, cache and lock keys, file names.
- Run `npm test` and `npm run typecheck` before calling a change done.
- In the final summary, say which help files (`src/guide/`, `src/glossary/`) were
  updated, or that none needed it.
