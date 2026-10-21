import { test, expect } from '@playwright/test'

// The bundle adjustment's threads on a synthetic block (opt-in: BA_SCALE=<side>, e.g. 40
// for 1,600 cameras; BA_SEEDS=5,1). Each seed runs once single-threaded and once on the
// pool: the poses must be the same bits, and the log line gives both times.
//   BA_SCALE=40 npx playwright test tests/browser/ba-scale.spec.js
const side = Number(process.env.BA_SCALE ?? 0)
const seeds = (process.env.BA_SEEDS ?? '5').split(',').map(Number)

for (const seed of seeds) {
  test(`bundle adjustment threads, ${side}×${side} cameras, seed ${seed}`, async ({ page }) => {
    test.skip(!side, 'set BA_SCALE to run')
    test.setTimeout(3_600_000)
    page.on('console', (m) => {
      if (/threaded|Bundle adjustment/.test(m.text())) console.log('PAGE', m.text())
    })
    await page.goto('/tests/browser/harness.html')
    const run = (threads) =>
      page.evaluate(
        ({ seed, side, threads }) =>
          new Promise((resolve) => {
            const w = new Worker('/tests/browser/workers/baScale.worker.js', { type: 'module' })
            w.onmessage = ({ data }) => {
              w.terminate()
              resolve(data)
            }
            w.onerror = (e) => resolve({ error: e.message })
            w.postMessage({ seed, side, threads })
          }),
        { seed, side, threads },
      )
    const one = await run(0)
    const many = await run(16)
    const row = (r) =>
      `SfM ${(r.ms / 1000).toFixed(1)} s, BA ${(r.baSolver.ms / 1000).toFixed(1)} s on ${r.baSolver.threads} thread(s), ` +
      `${r.baSolver.solves} solves, digest ${r.digest}`
    console.log(`seed ${seed}, ${side * side} cameras:\n  ${row(one)}\n  ${row(many)}`)
    expect(one.error ?? null).toBeNull()
    expect(many.error ?? null).toBeNull()
    expect(many.isolated).toBe(true)
    expect(many.baSolver.threads).toBeGreaterThan(1)
    expect(many.digest).toBe(one.digest)
  })
}
