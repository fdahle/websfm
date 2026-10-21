# Contributing

Thanks for your interest in websfm. Bug reports, test results on your own data and
pull requests are all welcome.

## Issues

- **Bugs:** use the bug report form, or the 🐞 button in the app. A log export
  (the developer console's **Save TXT**) and a description of the dataset (number of
  images, camera, aerial or close-range) help most.
- **Results on real data:** reports of how websfm did on a dataset, good or bad,
  are just as useful as bug reports, especially with reference data (GCPs, RTK).
- **Larger changes:** please open an issue to discuss the idea before you write a
  big pull request.

## Finding your way around

websfm is large (a photogrammetry pipeline is), but every part follows the same
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
npm run format      # Prettier; CI checks it with format:check
npm test
npm run typecheck
```

- **Formatting is Prettier's** (`.prettierrc.json`), so a review is about the code.
  Your editor can format on save with the Prettier extension. In a Vue template, an
  event handler with several statements is an arrow function,
  `@click="() => { a = 1; b() }"`: Prettier puts plain `a = 1; b()` on two lines
  without the semicolon, which Vue cannot parse (`npm run typecheck` catches it).
- **Keep pull requests small and focused**: one fix or feature each. They are
  reviewed faster, and a bisect can find what broke.
- **Rust changes:** run `npm run build:wasm` and commit the regenerated `src/wasm/`
  files with the source change. CI checks that they match.
- **User-visible changes:** update the in-app help (below) and add a line to the
  `[Unreleased]` section of [CHANGELOG.md](CHANGELOG.md).
- **Method changes:** update the matching section of [docs/METHODS.md](docs/METHODS.md).
- **Browser-only behaviour** (WebGPU, storage, dialogs) isn't covered by the unit
  tests. Say in the pull request what you checked by hand, and in which browser.
  For pipeline changes, a before/after run of the headless bench on the example
  dataset is the most convincing evidence.
- **AI-assisted contributions** are fine, as long as you have read and understood
  every line you submit and can answer questions about it.

## Keep the in-app help in step

The app explains itself in two places:

- `src/glossary/**/*.md`: concepts (SIFT, RANSAC, depth map …). Each entry has
  frontmatter `id/title/summary/aliases`; aliases auto-link wherever help text
  mentions them.
- `src/guide/*.md`: one article per operation, with a `## ` section per setting
  bound by `<!-- param: key  default: … -->`.

Whenever a change alters what a setting or operation does, changes a default, or
adds, removes or renames a setting, operation or user-visible feature:

1. Update the matching guide section and its `default:` marker, and any glossary
   entry whose text describes the old behaviour. (The unit tests check that every
   help link resolves; nothing checks the `default:` values, so look at them.)
2. A setting that has a guide section gets its label wrapped as
   `<FieldHelp op="…" param="…" :value="settings.x" :default-value="X_DEFAULTS.x">Label</FieldHelp>`.
   Pass the `*_DEFAULTS` constant, and leave both values out for selects.
   - Keep one hover target per label: don't add a `GlossaryTerm` inside or beside a
     `FieldHelp`. Make the guide text link the concept instead (auto-link or
     `[text](help:id)`), so it opens as a nested box.
   - Labels without a guide section may use `<GlossaryTerm id="…">`, pointing at the
     entry that explains that exact concept.
3. A new concept gets a new glossary entry. Keep aliases specific: a generic alias
   such as "projection" or "3D point" links in the wrong places.

## License

By contributing, you agree that your contribution is released under the project's
[MIT License](LICENSE).
