import { defineConfig } from 'vitest/config'

// Tests live alongside the pure compute layer in src/core/ (plus a few pure
// dependency-free helpers in src/utils/ and main-thread composables whose browser
// globals can be injected). No Vue plugin and a plain node environment: these
// import no SFCs, and the wasm modules run on Node's WebAssembly (loaded from bytes
// in the test setup). Keep test files under these globs free of direct DOM use.
//
// `src/stores/**` is included for store-layer modules that are plain functions —
// e.g. `stores/reconstruction/cloudSerde.js`, which is pure data transformation
// but applies `markRaw` and so cannot live under core/. There is still NO Vue
// plugin and no DOM here, so this covers plain `.js` only: a `.vue` SFC won't
// compile, and anything reaching for `document`/`window` or an active Pinia
// instance will not run. Importing Vue's reactivity (`markRaw`, `ref`) is fine —
// it is dependency-free JS.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/core/**/*.test.{js,ts}',
      'src/utils/**/*.test.{js,ts}',
      'src/stores/**/*.test.{js,ts}',
      'src/composables/**/*.test.{js,ts}',
    ],
  },
})
