// Does the WebGPU brute-force matcher agree with WASM on this machine? Planted
// descriptor pairs from one tile (64×64) to 9000×9000, cached and uncached buffers,
// with and without the cross-check (tests/bench/gpuMatchCheck.js). Exit 1 on any
// disagreement. Uses the same Chrome flags as a GPU bench run (README ▸ Linux).
//
//   node scripts/bench/gpu-match-check.mjs [--headless]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 4191
const vite = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: repo, stdio: 'ignore' })
let code = 1
try {
  for (let t0 = Date.now(); ; ) {
    try { if ((await fetch(`http://127.0.0.1:${port}/tests/bench/gpuMatchCheck.html`)).ok) break } catch {}
    if (Date.now() - t0 > 60_000) throw new Error('vite did not start')
    await new Promise((r) => setTimeout(r, 300))
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: process.argv.includes('--headless'),
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'] })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/tests/bench/gpuMatchCheck.html`)
  await page.waitForFunction(() => window.checkReady === true, null, { timeout: 60_000 })
  const r = await page.evaluate(() => window.check())
  console.log(`adapter: ${r.adapter} · run: ${r.begin}`)
  for (const c of r.cases ?? []) {
    console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.nA}×${c.nB} (${c.shared} planted, ${c.ids ? 'cached' : 'uncached'}, cross-check ${c.cross ? 'on' : 'off'}): `
      + `WASM ${c.cpu} / GPU ${c.gpu}${c.err ? ` — ${c.err}` : ''}`)
  }
  code = r.ok ? 0 : 1
  await browser.close()
} finally {
  vite.kill()
}
process.exit(code)
