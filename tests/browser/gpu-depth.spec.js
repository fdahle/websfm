import { test, expect } from './fixtures.js'

// The WebGPU PatchMatch kernel (patchmatch.wgsl) against the truth on the synthetic cases
// the Rust kernel is held to on every push (tests/bench/patchmatchCases.js,
// src/core/dense/patchmatchQuality.test.js), and its cost against the Rust cost of the
// same planes. Runs on Chrome's software WebGPU (SwiftShader), which needs no GPU: a
// runner has none. It filters textures in exact f32, so its cost matches the Rust cost to
// ~1e-6 (median difference), and MAX_COST_DIFF catches drift between the kernels far
// smaller than a hardware GPU's rounding would hide (DENSE_TUNING.gpuCheckWarn;
// scripts/bench/gpu-depth-check.mjs runs these cases on this machine's GPU).
const MAX_COST_DIFF = 1e-5

test('the WebGPU depth-map kernel reaches the Rust kernel’s bounds', async ({ browserName, playwright, baseURL }) => {
  test.skip(browserName !== 'chromium', 'WebGPU on a software adapter is a Chromium flag')
  test.setTimeout(300_000)
  const browser = await playwright.chromium.launch({
    args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader'],
  })
  try {
    const page = await browser.newPage({ baseURL })
    await page.goto('/tests/bench/gpuDepthCheck.html')
    await page.waitForFunction(() => window.checkReady === true, null, { timeout: 60_000 })
    const r = await page.evaluate(() => window.check())
    expect(r.adapter, 'a WebGPU adapter').toBeTruthy()
    expect(r.cases.length).toBeGreaterThan(0)
    for (const c of r.cases) {
      expect(c.failures, `${c.label}${c.err ? `: ${c.err}` : ''}`).toEqual([])
      expect(c.check.median, `${c.label}: cost against the Rust cost`).toBeLessThan(MAX_COST_DIFF)
    }
  } finally {
    await browser.close()
  }
})
