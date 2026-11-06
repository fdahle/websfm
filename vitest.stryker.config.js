import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.js'

// The unit tests as Stryker runs them (stryker.config.json, npm run test:mutation): its
// coverage instrumentation slows the real-kernel tests past the usual 30 s limit, and
// the tests that start Node worker threads through the `web-worker` polyfill (the
// GeoTIFF paths) fail to start in its sandbox. None of those imports a module Stryker
// mutates by default; add a module of theirs to `mutate` and its tests are missed.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 180_000,
      exclude: [
        ...configDefaults.exclude,
        'src/core/products/exporters.test.js',
        'src/core/products/warpExport.test.js',
        'src/core/products/texture/texturedObjExport.test.js',
        'src/workers/ops/reflectance.test.js',
        'src/utils/rasterParse.test.js',
      ],
    },
  }),
)
