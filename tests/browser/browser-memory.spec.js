import { test, expect } from '@playwright/test'

// Past the ArrayBuffer limits (core/bigArray.js, dev/planning/plan-past-browser-limits.md):
// the page's capabilities, a shared array handed to a worker without a copy, and the
// Memory64 Poisson build (src/wasm/mesh-64) giving the same mesh as the 32-bit one.

test('wasm memories: Memory64 and shared memory are there, and a shared array reaches a worker uncopied', async ({
  page,
}) => {
  await page.goto('/tests/browser/harness.html')
  const r = await page.evaluate(async () => {
    const { bigArrayCaps, shareableArray } = await import('/src/core/bigArray.js')
    const caps = bigArrayCaps()
    const a = shareableArray(Float32Array, 1000, { maxPlainBytes: 0 })
    const src = `onmessage = (e) => { e.data[7] = 42; postMessage(e.data.length) }`
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    const len = await new Promise((resolve) => {
      w.onmessage = (e) => resolve(e.data)
      w.postMessage(a)
    })
    w.terminate()
    return { caps, len, seen: a[7] }
  })
  expect(r.caps.memory64).toBe(true)
  expect(r.caps.shared).toBe(true)
  expect(r.caps.maxShareableBytes).toBe(16 * 2 ** 30)
  expect(r.len).toBe(1000)
  expect(r.seen).toBe(42)
})

test('the Memory64 Poisson build gives the 32-bit build’s mesh, byte for byte', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/tests/browser/harness.html')
  const r = await page.evaluate(async () => {
    const N = 20000
    let s = 7
    const rnd = () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32
    const pos = new Float32Array(3 * N),
      nrm = new Float32Array(3 * N)
    for (let i = 0; i < N; i++) {
      const x = rnd() * 100,
        y = rnd() * 100
      const gx = (5 / 7) * Math.cos(x / 7) * Math.cos(y / 9),
        gy = (-5 / 9) * Math.sin(x / 7) * Math.sin(y / 9)
      const m = Math.hypot(gx, gy, 1)
      pos.set([x, y, 5 * Math.sin(x / 7) * Math.cos(y / 9)], 3 * i)
      nrm.set([-gx / m, -gy / m, 1 / m], 3 * i)
    }
    const solve = async (path) => {
      const mod = await import(path)
      await mod.default()
      const me = mod.PoissonMesher.build(pos, nrm, new Float32Array(0), 7, 4)
      for (let L = me.num_layers(), i = 0; i < L; i++) me.solve_step()
      const bytes = me.finish(0, 0.1, 0.05, 0.01)
      me.free()
      return bytes
    }
    const a = await solve('/src/wasm/mesh/mesh.js')
    const b = await solve('/src/wasm/mesh-64/mesh.js')
    let same = a.length === b.length
    for (let i = 0; same && i < a.length; i++) same = a[i] === b[i]
    return { bytes: a.length, same }
  })
  expect(r.bytes).toBeGreaterThan(1000)
  expect(r.same).toBe(true)
})
