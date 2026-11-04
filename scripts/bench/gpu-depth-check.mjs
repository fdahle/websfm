// Does the WebGPU PatchMatch kernel reach the bounds the Rust kernel is held to, and does
// its cost agree with the Rust cost, on this machine's GPU? The synthetic cases of
// tests/bench/patchmatchCases.js (tests/bench/gpuDepthCheck.js). The nightly browser suite
// runs them on a software GPU (SwiftShader); this runs them on real hardware, whose
// texture sampler differs. Exit 1 on a missed bound or a cost check over the warning
// level (DENSE_TUNING.gpuCheckWarn).
// Uses the same Chrome flags as a GPU bench run (README ▸ Linux).
//
//   node scripts/bench/gpu-depth-check.mjs [--headless] [--swiftshader]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DENSE_TUNING } from '../../src/core/tuning.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4192
const page_ = `http://127.0.0.1:${port}/tests/bench/gpuDepthCheck.html`
const soft = process.argv.includes('--swiftshader')
const vite = spawn(
  process.execPath,
  [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: repo, stdio: 'ignore' },
)
let code = 1
try {
  for (let t0 = Date.now(); ;) {
    try {
      if ((await fetch(page_)).ok) break
    } catch {}
    if (Date.now() - t0 > 60_000) throw new Error('vite did not start')
    await new Promise((r) => setTimeout(r, 300))
  }
  const browser = await chromium.launch({
    channel: soft ? undefined : 'chrome',
    headless: soft || process.argv.includes('--headless'),
    args: soft
      ? ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']
      : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  })
  const page = await browser.newPage()
  await page.goto(page_)
  await page.waitForFunction(() => window.checkReady === true, null, { timeout: 60_000 })
  const r = await page.evaluate(() => window.check())
  console.log(`adapter: ${r.adapter ?? 'none (no WebGPU)'}`)
  const limit = DENSE_TUNING.gpuCheckWarn
  let ok = !!r.adapter
  for (const c of r.cases) {
    const s = c.score
    const checkOk = c.check != null && c.check.median < limit
    const pass = !c.failures.length && checkOk
    ok &&= pass
    console.log(
      `${pass ? 'OK  ' : 'FAIL'} ${c.id.padEnd(8)} ` +
        (c.err
          ? c.err
          : `within 1 % ${s.within1.toFixed(3)} · 0.2 % ${s.within02.toFixed(3)} · median ${(100 * s.median).toFixed(3)} %` +
            `${s.band1 != null ? ` · strip ${s.band1.toFixed(3)}` : ''} · cost diff median ${c.check?.median.toExponential(2)} / 90 % ${c.check?.p90.toExponential(2)} / RMS ${c.check?.rms.toExponential(2)}` +
            ` · ${(c.ms / 1000).toFixed(1)} s${c.failures.length ? ` — ${c.failures.join(', ')}` : ''}`),
    )
  }
  code = ok ? 0 : 1
  await browser.close()
} finally {
  vite.kill()
}
process.exit(code)
