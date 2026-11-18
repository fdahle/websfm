<!-- Thanks for the pull request. One fix or feature each; CONTRIBUTING.md says what a change needs. -->

## What and why

<!-- What this changes and the problem it solves. Link the issue if there is one: Fixes #123 -->

## How it was checked

<!-- The tests you added or changed. For browser-only behaviour (WebGPU, storage, dialogs):
     what you checked by hand, and in which browser. For a pipeline change: a before/after
     run of the headless bench on the example dataset, if you have one. -->

## Checklist

- [ ] `npm run check` passes
- [ ] One fix or feature, nothing unrelated
- [ ] A user would notice it: the in-app help (`src/guide/`, `src/glossary/`) is updated and `CHANGELOG.md` has an entry under `[Unreleased]`
- [ ] It changes code under `crates/`: `npm run build:wasm` was run and `src/wasm/` is committed
- [ ] It changes what a project saves: a format migration and a fixture (`docs/project-format.md`)
- [ ] I have read and understand every line, including any written with an AI tool

<!-- Leave the boxes that do not apply unticked and say so in a word. -->
