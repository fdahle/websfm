import { ortVersion } from './scripts/ort-version.mjs'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

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
    ],
    // The compute worker dynamic-imports onnxruntime-web (SuperPoint/LightGlue),
    // which code-splits — unsupported by the default `iife` worker format. The
    // worker is already instantiated as `{ type: 'module' }` (computeClient.js), so
    // emit ES-module worker chunks.
    worker: { format: 'es' },
    // This is an offline-capable compute application rather than a document-sized
    // site. Keep an explicit entry-chunk budget just above the measured shell after
    // the map, 3D viewer, help/report dialogs, TIFF decoder and CRS catalog have been
    // split out. Future growth past this baseline should warn again.
    build: { chunkSizeWarningLimit: 1750 },
    // Keep esbuild's dep pre-bundler away from onnxruntime-web: bundling it rewrites
    // ORT's internal wasm-glue references and breaks the wasm↔JS binding at runtime
    // ("ke.$b is not a function"). Excluding it serves ORT's own ESM untouched.
    optimizeDeps: { exclude: ['onnxruntime-web', '@sqlite.org/sqlite-wasm'] },
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
