// Build config for the headless bench: the app's own Vite config with the bench page as
// the only entry, so a run executes a frozen snapshot of the code. Running against the
// dev server instead let any source edit hot-reload the page mid-run.
import baseConfig from '../../vite.config.js'

export default (env) => {
  const cfg = baseConfig(env)
  return {
    ...cfg,
    build: {
      ...cfg.build,
      outDir: process.env.BENCH_OUT_DIR,
      emptyOutDir: true,
      rollupOptions: { input: 'tests/bench/bench.html' },
    },
  }
}
