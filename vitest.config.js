import { defineConfig } from 'vitest/config'

// Tests live alongside the pure compute layer in src/core/. No Vue plugin and a
// plain node environment: core imports no Vue/Pinia, and the wasm modules run on
// Node's WebAssembly (loaded from bytes in the test setup).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/core/**/*.test.{js,ts}'],
  },
})
