import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export default defineConfig({
  plugins: [
    vue(),
    // Serve ORT's wasm runtime at /ort/ (dev middleware + build copy). ORT
    // dynamically imports its wasm-loader .mjs at runtime and feature-detects
    // which variant (asyncify/jsep/jspi) to use — so we ship them all under one
    // prefix. This can't live in /public: Vite's dev server refuses to serve
    // /public files as importable ES modules (the dynamic .mjs import fails).
    viteStaticCopy({
      targets: [{
        src: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.{wasm,mjs}',
        dest: 'ort',
        // Flatten: emit files at /ort/<name>, not /ort/node_modules/onnxruntime-web/dist/<name>.
        rename: { stripBase: true },
      }],
    }),
  ],
  // The compute worker dynamic-imports onnxruntime-web (SuperPoint/LightGlue),
  // which code-splits — unsupported by the default `iife` worker format. The
  // worker is already instantiated as `{ type: 'module' }` (computeClient.js), so
  // emit ES-module worker chunks.
  worker: { format: 'es' },
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
})
