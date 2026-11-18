# Contributing

Thanks for your interest in WebSfM. Bug reports, test results on your own data and
pull requests are all welcome.

## Issues

- **Bugs:** use the bug report form, or the 🐞 button in the app. A log export
  (the developer console's **Save TXT**) and a description of the dataset (number of
  images, camera, aerial or close-range) help most.
- **Results on real data:** reports of how WebSfM did on a dataset, good or bad,
  are just as useful as bug reports, especially with reference data (GCPs, RTK).
  Post them in [Discussions ▸ Show and tell](https://github.com/fdahle/websfm/discussions/categories/show-and-tell),
  and questions in [Q&A](https://github.com/fdahle/websfm/discussions/categories/q-a).
- **Larger changes:** please open an issue to discuss the idea before you write a
  big pull request.

## Finding your way around

WebSfM is large (a photogrammetry pipeline is), but every part follows the same
pattern, so you only need to understand the part you change.

1. Run it: `npm install`, `npm run fetch:examples`, `npm run dev`, then open the
   example project and follow its walkthrough. You'll have seen every stage once.
2. Read [ARCHITECTURE.md](ARCHITECTURE.md). Its *Following one operation through the
   code* and *Where to change what* tables tell you which files a change touches.
3. For the algorithms, read the matching section of [docs/METHODS.md](docs/METHODS.md).

The most important rule: code in `src/core/` is pure computation, with no Vue,
Pinia, browser storage or DOM. That is what lets it run in a worker and in the Node
tests, and it is usually where a fix belongs.

Good places to start are issues labelled
[`good first issue`](https://github.com/fdahle/websfm/labels/good%20first%20issue),
a clearer guide or glossary text (`src/guide/`, `src/glossary/`), or a test for a
`src/core/` function that has none.

## Development setup

```bash
npm install
npm run dev
```

The compiled WASM modules are committed, so you only need the Rust toolchain if you
change code under `crates/`. [docs/development.md](docs/development.md) covers the
tests, the headless pipeline bench and rebuilding the WASM.

## Before you open a pull request

```bash
npm run format      # Prettier: formats the files
npm run check       # what CI checks: format:check, typecheck (with ESLint), unit tests
```

- **Formatting is Prettier's** (`.prettierrc.json`), so a review is about the code.
  Your editor can format on save with the Prettier extension. In a Vue template, an
  event handler with several statements is an arrow function,
  `@click="() => { a = 1; b() }"`: Prettier puts plain `a = 1; b()` on two lines
  without the semicolon, which Vue cannot parse (`npm run typecheck` catches it).
- **Tests check what the result must be**, not what the code returned when you ran it:
  known truth, properties of the maths, an outside reference with one right answer.
  Break the code on purpose and see the test fail ([docs/development.md](docs/development.md#writing-tests-that-catch-bugs)).
- **Keep pull requests small and focused**: one fix or feature each. They are
  reviewed faster, and a bisect can find what broke.
- **Rust changes:** run `npm run build:wasm` and commit the regenerated `src/wasm/`
  files with the source change. CI checks that they match.
- **User-visible changes:** update the in-app help
  ([conventions](docs/conventions.md#keep-the-in-app-help-in-step)) and add an entry to the
  `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md), under Added, Changed,
  Performance or Fixed. The app shows it in Other ▸ What's New, whose short view keeps
  only the bold headline and the first sentence, so write it in that order:
  - **a bold headline:** what a user can now do (`**Meshes in tiles.**`);
  - **one sentence:** how it works, in the user's terms and the app's labels;
  - **then the detail and the evidence**, such as bench numbers, which only the Full
    view shows.

  Leave released sections alone; `npm run release` moves `[Unreleased]` under a new
  version (see [docs/development.md](docs/development.md#releases)).
- **Method changes:** update the matching section of [docs/METHODS.md](docs/METHODS.md).
- **Saved-project changes:** a project saved by WebSfM opens in every later version.
  A new field that older projects simply lack needs nothing more than a default where
  it is read. Any other change to what a project saves needs a format migration and a
  new test fixture: [docs/project-format.md](docs/project-format.md) says how.
- **Browser-only behaviour** (WebGPU, storage, dialogs) isn't covered by the unit
  tests. Say in the pull request what you checked by hand, and in which browser.
  For pipeline changes, a before/after run of the headless bench on the example
  dataset is the most convincing evidence.
- **AI-assisted contributions** are fine, as long as you have read and understood
  every line you submit and can answer questions about it.

## Conventions

The house rules are in [docs/conventions.md](docs/conventions.md), one section per kind
of change. Most are checked by `npm run check`, so a failing test usually names the rule.
Read the section your change touches:

| Your change | Read |
| --- | --- |
| a setting, an operation or anything else a user sees | [Keep the in-app help in step](docs/conventions.md#keep-the-in-app-help-in-step) |
| code, a model or data from somewhere else | [Third-party code and data](docs/conventions.md#third-party-code-and-data) |
| a control that can be disabled | [Disabled controls say why](docs/conventions.md#disabled-controls-say-why) |
| words a user reads | [Text in the UI](docs/conventions.md#text-in-the-ui), [Menu labels](docs/conventions.md#menu-labels) |
| a step made faster or better | [An option or not](docs/conventions.md#an-option-or-not) |
| any dialog | [Every dialog's frame](docs/conventions.md#every-dialogs-frame) |
| a dialog that runs a processing step | [Dialogs of a processing step](docs/conventions.md#dialogs-of-a-processing-step) |
| log lines, or anything the mouse can do | [The console](docs/conventions.md#the-console) |

A small fix rarely touches more than one of them, and a reviewer will point you to the
one you missed.

## Conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contribution is released under the project's
[MIT License](LICENSE).
