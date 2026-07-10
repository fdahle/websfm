import { defineConfig } from 'vitest/config'

// Tests live alongside the pure compute layer in src/core/ (plus a few pure
// dependency-free helpers in src/utils/, e.g. zip.js). No Vue plugin and a plain
// node environment: these import no Vue/Pinia, and the wasm modules run on Node's
// WebAssembly (loaded from bytes in the test setup). Keep test files under these
// globs free of Vue/Pinia/DOM imports.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/core/**/*.test.{js,ts}', 'src/utils/**/*.test.{js,ts}'],
  },
})
