import { describe, it, expect } from 'vitest'
import { planCloudSlabs, gatherPoints } from './cloudSlabs.js'
import { statisticalOutlierFilter, sorNeighbourMeans, cloudBounds, estimateSpacing } from './cloudEdit.js'

function terrain(n, seed = 3) {
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const pos = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const x = rnd() * 100,
      y = rnd() * 40
    // A surface with a few flyers.
    pos[3 * i] = x
    pos[3 * i + 1] = y
    pos[3 * i + 2] = i % 97 === 0 ? 5 + rnd() * 20 : Math.sin(x / 9) + 0.02 * rnd()
  }
  return { count: n, pos }
}

describe('planCloudSlabs', () => {
  it('gives every point to one slab, and a margin point to each slab within reach', () => {
    const c = terrain(20000)
    const halo = 2
    const { axis, parts } = planCloudSlabs(c.pos, c.count, { slabs: 5, halo })
    expect(axis).toBe(0) // the longer side
    const owner = new Int32Array(c.count).fill(-1)
    for (const [s, p] of parts.entries())
      for (let j = 0; j < p.own; j++) {
        expect(owner[p.idx[j]]).toBe(-1)
        owner[p.idx[j]] = s
      }
    expect(owner.every((s) => s >= 0)).toBe(true)
    // Even slabs: the cuts are quantiles.
    for (const p of parts) expect(Math.abs(p.own - c.count / 5)).toBeLessThan(c.count * 0.02)
    // A slab's margin: every other point within `halo` of its own points' range.
    for (const p of parts) {
      let lo = Infinity,
        hi = -Infinity
      for (let j = 0; j < p.own; j++) {
        const v = c.pos[3 * p.idx[j]]
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
      const inSlab = new Set(p.idx)
      for (let i = 0; i < c.count; i++) {
        const v = c.pos[3 * i]
        if (v >= lo - halo + 1e-9 && v <= hi + halo - 1e-9) expect(inSlab.has(i)).toBe(true)
      }
    }
  })

  it('splits the outlier filter exactly: the same points survive', () => {
    const c = terrain(30000)
    const whole = statisticalOutlierFilter(c, { k: 12, stdRatio: 1.5 })
    const reach = 4 * estimateSpacing(cloudBounds(c), c.count)
    const mean = new Float64Array(c.count),
      lonely = new Uint8Array(c.count)
    for (const p of planCloudSlabs(c.pos, c.count, { slabs: 4, halo: reach }).parts) {
      const r = sorNeighbourMeans(gatherPoints(c, p.idx), { k: 12, reach })
      for (let j = 0; j < p.own; j++) {
        mean[p.idx[j]] = r.mean[j]
        lonely[p.idx[j]] = r.lonely[j]
      }
    }
    const ref = sorNeighbourMeans(c, { k: 12 })
    for (let i = 0; i < c.count; i++) {
      expect(mean[i]).toBe(ref.mean[i])
      expect(lonely[i]).toBe(ref.lonely[i])
    }
    // …so the cut over the whole cloud's mean + 1.5σ keeps the same points.
    let cnt = 0,
      s1 = 0,
      s2 = 0
    for (let i = 0; i < c.count; i++)
      if (!lonely[i]) {
        cnt++
        s1 += mean[i]
        s2 += mean[i] ** 2
      }
    const limit = s1 / cnt + 1.5 * Math.sqrt(s2 / cnt - (s1 / cnt) ** 2)
    let kept = 0
    for (let i = 0; i < c.count; i++) if (!lonely[i] && mean[i] <= limit) kept++
    expect(kept).toBe(whole.count)
    expect(whole.count).toBeLessThan(c.count)
  })
})
