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

## Development setup

```bash
npm install
npm run dev
```

The compiled WASM modules are committed, so you only need the Rust toolchain if you
change code under `crates/`. See the [README](README.md#rebuilding-the-wasm-crates).

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the code is organised. The most
important rule: code in `src/core/` is pure computation, with no Vue, Pinia, browser
storage or DOM.

## Before you open a pull request

```bash
npm test
npm run typecheck
```

- **Rust changes:** run `npm run build:wasm` and commit the regenerated `src/wasm/`
  files with the source change. CI checks that they match.
- **User-visible changes:** update the matching article in `src/guide/` in the same
  pull request, and add a line to the `[Unreleased]` section of
  [CHANGELOG.md](CHANGELOG.md).
- **Browser-only behaviour** (WebGPU, storage, dialogs) isn't covered by the unit
  tests. Say in the pull request what you checked by hand, and in which browser.
- **AI-assisted contributions** are fine, as long as you have read and understood
  every line you submit and can answer questions about it.

## License

By contributing, you agree that your contribution is released under the project's
[MIT License](LICENSE).
