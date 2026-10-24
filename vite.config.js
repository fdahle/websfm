import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ortVersion } from './scripts/ort-version.mjs'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { VitePWA } from 'vite-plugin-pwa'
import { GIBS_CAPABILITIES, ORT_RUNTIME, TILE_CACHES } from './src/core/offlineCache.js'
import { MODELS, isRedistributable } from './src/core/models/registry.js'

// Vite copies public/ into the build wholesale, including a developer's local
// copy of weights whose license forbids hosting them (SuperPoint; registry.js
// decides). Remove those from the output so dev keeps using the local file while
// a build can never ship it. scripts/check-release.mjs still verifies the absence.
function excludeRestrictedModels() {
  let outDir, logger
  return {
    name: 'websfm:exclude-restricted-models',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
      logger = config.logger
    },
    async writeBundle() {
      // A headless bench build (scripts/bench/vite.bench.config.mjs) is a local snapshot,
      // never published, and needs the developer's own copy (scripts/bench/README.md).
      if (process.env.BENCH_OUT_DIR) return
      for (const [id, model] of Object.entries(MODELS)) {
        if (isRedistributable(id)) continue
        try {
          await rm(join(outDir, 'models', model.file))
          logger.info(`Left out models/${model.file} (${model.license})`)
        } catch {
          /* not in public/models/: nothing to remove */
        }
      }
    },
  }
}

// A Workbox runtime-caching rule: `CacheFirst` keeps an entry until its cache
// evicts it; CORS-only (status 200), because an opaque response cannot be checked
// and Chrome counts each one as ~7 MB of quota.
function cacheRule({ name, pattern, maxEntries, maxAgeSeconds }, handler = 'CacheFirst') {
  return {
    urlPattern: pattern,
    handler,
    options: {
      cacheName: name,
      expiration: { maxEntries, maxAgeSeconds, purgeOnQuotaError: true },
      cacheableResponse: { statuses: [200] },
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const base = env.VITE_BASE_PATH || '/'

  if (!base.startsWith('/') || !base.endsWith('/')) {
    throw new Error('VITE_BASE_PATH must start and end with "/" (for example, "/websfm/")')
  }

  return {
    base,
    plugins: [
      vue(),
      excludeRestrictedModels(),
      // Serve ORT's wasm runtime at /ort/ (dev middleware + build copy). ORT
      // dynamically imports its wasm-loader .mjs at runtime and feature-detects
      // which variant (asyncify/jsep/jspi) to use — so we ship them all under one
      // prefix. This can't live in /public: Vite's dev server refuses to serve
      // /public files as importable ES modules (the dynamic .mjs import fails).
      viteStaticCopy({
        targets: [
          {
            src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{wasm,mjs}',
            dest: `ort/${ortVersion}`,
            // Flatten: emit files at /ort/<name>, not /ort/node_modules/onnxruntime-web/dist/<name>.
            rename: { stripBase: true },
          },
          // Ship the application's own license with every static build. The About
          // dialog links here rather than assuming the GitHub repository is reachable.
          { src: 'LICENSE', dest: '.' },
        ],
      }),
      // Installable, offline-capable app: a manifest plus a generated service worker
      // that precaches the built app. Updates wait for the user (registerType
      // 'prompt', composables/useAppUpdate.js), because reloading mid-reconstruction
      // would lose the run. Models are not precached: Cache Storage already holds
      // them after the consent download (core/models/modelCache.js).
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        // The glob below already precaches the icons (the plugin adds the manifest).
        includeManifestIcons: false,
        manifest: {
          name: 'WebSfM — photogrammetry in your browser',
          short_name: 'WebSfM',
          description: 'Structure-from-Motion and photogrammetry, entirely in the browser.',
          theme_color: '#171a21',
          background_color: '#1e1e1e',
          display: 'standalone',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // The app shell, workers, our own wasm, the EPSG catalog and KaTeX's woff2
          // (browsers that read the PWA cache all take woff2). ORT's runtime is
          // cached on first use instead (ORT_RUNTIME); models and example datasets
          // never go through here.
          // The geoid grids (core/verticalDatum.js, 1.6 MB each) convert heights offline.
          globPatterns: ['**/*.{html,js,css,wasm,json,svg,png,woff2}', 'geoid/*.i16.z'],
          globIgnores: ['models/**', 'examples/**', 'ort/**', '**/ort-wasm-*'],
          // The entry chunk (~2 MB) and the EPSG catalog (~8 MB) exceed the 2 MB default.
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          cleanupOutdatedCaches: true,
          runtimeCaching: [
            cacheRule(ORT_RUNTIME),
            ...TILE_CACHES.map((cache) => cacheRule(cache)),
            cacheRule(GIBS_CAPABILITIES, 'StaleWhileRevalidate'),
          ],
        },
      }),
    ],
    // The compute worker dynamic-imports onnxruntime-web (SuperPoint/LightGlue),
    // which code-splits — unsupported by the default `iife` worker format. The
    // worker is already instantiated as `{ type: 'module' }` (computeClient.js), so
    // emit ES-module worker chunks.
    worker: { format: 'es' },
    // This is an offline-capable compute application rather than a document-sized
    // site. Keep an explicit entry-chunk budget just above the measured shell after
    // the map, 3D viewer, help/report dialogs, help markdown renderer (marked +
    // KaTeX), TIFF decoder and CRS catalog have been split out (1,816 kB in
    // October 2026). Future growth past this baseline should warn again; the next
    // candidates to split are the statically imported dialogs in
    // components/modals/{Pipeline,Data,Project}Modals.vue.
    build: { chunkSizeWarningLimit: 1850 },
    // Keep esbuild's dep pre-bundler away from onnxruntime-web: bundling it rewrites
    // ORT's internal wasm-glue references and breaks the wasm↔JS binding at runtime
    // ("ke.$b is not a function"). Excluding it serves ORT's own ESM untouched.
    // The dev server pre-bundles what it finds from these pages; a dependency met only
    // later (from a worker or a lazy import) is bundled then and the page reloads, which
    // killed the first Playwright test of a cold run. So the test and bench pages are
    // scanned too, and the late finds are listed.
    optimizeDeps: {
      exclude: ['onnxruntime-web', '@sqlite.org/sqlite-wasm'],
      entries: ['index.html', 'tests/browser/*.html', 'tests/bench/*.html'],
      include: ['fflate'],
    },
    // Cross-origin isolation → SharedArrayBuffer → multi-threaded ORT wasm (core/ort.js
    // auto-picks threads when `crossOriginIsolated`; ~3× on LightGlue/SuperPoint CPU).
    // COEP `credentialless` (NOT `require-corp`) is deliberate: it still permits
    // cross-origin no-cors subresources like the OpenLayers basemap tiles, just
    // stripped of credentials. Safari doesn't support `credentialless` and simply
    // stays un-isolated/single-threaded — the code path degrades gracefully.
    // A production host must send these same two headers to get threads there.
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
  }
})
