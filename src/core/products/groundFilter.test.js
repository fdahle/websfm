import { describe, it, expect } from 'vitest'
import {
  classifyGround,
  classifyCloudGround,
  CLASS_GROUND,
  CLASS_UNCLASSIFIED,
  CLASS_LOW_POINT,
  CLASS_NEVER,
} from './groundFilter.js'
import { makeFrame, frameFromScaledLocal } from './projection.js'

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function gauss(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
}

// Rolling terrain with a regional slope: ~2 m of relief over 100 m plus 5 % grade.
const terrain = (x, y) => 0.05 * x + 2 * Math.sin(x / 20) * Math.cos(y / 25)

// A photogrammetric-looking scene over 100×100 m: ground at `step` spacing with
// 3 cm noise, two buildings (roof and walls only: no ground under a roof), a row
// of trees (canopy blobs and a few trunk points) and a handful of low outliers.
// truth[i]: 2 ground, 1 object, 7 low noise.
function scene({ step = 0.25, seed = 1, jitter = 0 } = {}) {
  const rand = rng(seed)
  const xyz = [],
    truth = []
  const push = (x, y, z, cls) => {
    // Jitter moves points off the regular grid (and so off the cloth's cell edges).
    xyz.push(x + jitter * (rand() - 0.5), y + jitter * (rand() - 0.5), z)
    truth.push(cls)
  }
  const buildings = [
    { x0: 20, x1: 40, y0: 20, y1: 32, h: 8 },
    { x0: 60, x1: 75, y0: 55, y1: 80, h: 12 },
  ]
  const inBuilding = (x, y) => buildings.find((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)
  for (let x = 0; x <= 100; x += step) {
    for (let y = 0; y <= 100; y += step) {
      const b = inBuilding(x, y)
      if (b) {
        // Flat roof at the eave height above the building's lowest corner.
        const base = Math.min(terrain(b.x0, b.y0), terrain(b.x1, b.y1), terrain(b.x0, b.y1), terrain(b.x1, b.y0))
        push(x, y, base + b.h + 0.03 * gauss(rand), 1)
      } else {
        push(x, y, terrain(x, y) + 0.03 * gauss(rand), 2)
      }
    }
  }
  // Walls, sparsely sampled from 1 m above ground to the eave.
  for (const b of buildings) {
    const base = Math.min(terrain(b.x0, b.y0), terrain(b.x1, b.y1), terrain(b.x0, b.y1), terrain(b.x1, b.y0))
    for (let t = 0; t <= 1; t += 0.02) {
      for (let h = 1; h < b.h; h += 0.5) {
        push(b.x0 + t * (b.x1 - b.x0), b.y0, base + h, 1)
        push(b.x0, b.y0 + t * (b.y1 - b.y0), base + h, 1)
      }
    }
  }
  // Trees: canopy hemispheres 4–9 m up (ground below them is still seen).
  for (let k = 0; k < 8; k++) {
    const cx = 10 + k * 11,
      cy = 90,
      r = 3
    for (let i = 0; i < 600; i++) {
      const a = rand() * 2 * Math.PI,
        rr = r * Math.sqrt(rand())
      const x = cx + rr * Math.cos(a),
        y = cy + rr * Math.sin(a)
      push(x, y, terrain(x, y) + 4 + 5 * Math.sqrt(1 - (rr / r) ** 2), 1)
    }
    for (let h = 0.8; h < 4; h += 0.2) push(cx, cy, terrain(cx, cy) + h, 1)
  }
  // Isolated below-ground noise (matching blunders).
  for (let k = 0; k < 20; k++) {
    const x = 5 + rand() * 90,
      y = 5 + rand() * 10
    push(x, y, terrain(x, y) - 3 - rand() * 4, 7)
  }
  return { pos: Float64Array.from(xyz), count: truth.length, truth: Uint8Array.from(truth) }
}

function score(classes, truth, cls) {
  let tp = 0,
    fp = 0,
    fn = 0
  for (let i = 0; i < truth.length; i++) {
    const p = classes[i] === cls,
      t = truth[i] === cls
    if (p && t) tp++
    else if (p) fp++
    else if (t) fn++
  }
  return { precision: tp / (tp + fp), recall: tp / (tp + fn) }
}

describe('classifyGround', () => {
  it('separates terrain from buildings, trees and low noise', () => {
    const { pos, count, truth } = scene()
    const res = classifyGround(pos, count, { clothResolution: 1 })
    const g = score(res.classes, truth, CLASS_GROUND)
    expect(g.precision).toBeGreaterThan(0.995)
    expect(g.recall).toBeGreaterThan(0.98)
    // Every roof point is above ground, and every planted blunder is a low point.
    const o = score(res.classes, truth, CLASS_UNCLASSIFIED)
    expect(o.precision).toBeGreaterThan(0.99)
    expect(score(res.classes, truth, CLASS_LOW_POINT).recall).toBe(1)
    expect(res.counts.ground + res.counts.unclassified + res.counts.low + res.counts.never).toBe(count)
    expect(res.converged).toBe(true)
  })

  it('leaves the cloth on the terrain under a building', () => {
    const { pos, count } = scene()
    const res = classifyGround(pos, count, { clothResolution: 1, rigidness: 3 })
    const { cloth } = res
    // Particle nearest the first building's centre (30, 26).
    const c = Math.round((30 - cloth.originX) / cloth.res - 0.5)
    const r = Math.round((cloth.originY - 26) / cloth.res - 0.5)
    expect(Math.abs(cloth.z[r * cloth.width + c] - terrain(30, 26))).toBeLessThan(1.5)
  })

  it('gives the same classes for a shifted cloud (survey coordinates)', () => {
    const { pos, count } = scene({ step: 0.5, seed: 3 })
    const a = classifyGround(pos, count, { clothResolution: 1 })
    const shifted = Float64Array.from(pos)
    for (let i = 0; i < count; i++) {
      shifted[i * 3] += 500_000
      shifted[i * 3 + 1] += 4_300_000
    }
    const b = classifyGround(shifted, count, { clothResolution: 1 })
    let diff = 0
    for (let i = 0; i < count; i++) if (a.classes[i] !== b.classes[i]) diff++
    // A randomly placed wall or tree point within a float ulp (~1e-9 m at 4.3e6)
    // of a cell edge may land in the other cell; nothing else may change.
    expect(diff).toBeLessThan(count * 1e-3)
  })

  it('classifies only inside the bounds and marks the rest never classified', () => {
    const { pos, count } = scene({ step: 0.5 })
    const res = classifyGround(pos, count, { bounds: { minX: 0, minY: 0, maxX: 50, maxY: 100 } })
    for (let i = 0; i < count; i++) {
      if (pos[i * 3] > 50) expect(res.classes[i]).toBe(CLASS_NEVER)
    }
    expect(res.counts.never).toBeGreaterThan(0)
  })

  it('coarsens the cloth to the particle cap and says so', () => {
    const { pos, count } = scene({ step: 1 })
    const logs = []
    const res = classifyGround(pos, count, { clothResolution: 0.1, maxParticles: 10_000, onLog: (m) => logs.push(m) })
    expect(res.cloth.width * res.cloth.height).toBeLessThanOrEqual(10_000)
    expect(logs.some((m) => /would need more than/.test(m))).toBe(true)
  })

  it('leaves non-finite points unclassified and does not mutate its input', () => {
    const pos = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, NaN, 0.5, 0])
    const copy = Float64Array.from(pos)
    const res = classifyGround(pos, 5)
    expect(Array.from(res.classes.subarray(0, 4))).toEqual([2, 2, 2, 2])
    expect(res.classes[4]).toBe(CLASS_NEVER)
    expect(pos).toEqual(copy)
  })

  it('returns null when nothing is inside the bounds', () => {
    const pos = new Float64Array([0, 0, 0, 1, 1, 0])
    expect(classifyGround(pos, 2, { bounds: { minX: 5, minY: 5, maxX: 6, maxY: 6 } })).toBe(null)
  })

  it('rejects invalid settings', () => {
    const pos = new Float64Array([0, 0, 0])
    expect(() => classifyGround(pos, 1, { classThreshold: 0 })).toThrow()
    expect(() => classifyGround(pos, 1, { rigidness: 4 })).toThrow()
  })
})

describe('classifyCloudGround', () => {
  // The scene in an SfM-like frame: tilted 30° about x, shifted, at 1/20 scale.
  // The frame below maps it back, so the classes must match the metric scene's.
  function tiltedScene() {
    const { pos, count, truth } = scene({ step: 0.5, seed: 5, jitter: 0.2 })
    const c = Math.cos(Math.PI / 6),
      s = Math.sin(Math.PI / 6),
      k = 1 / 20
    const origin = [3, -2, 7]
    const east = [1, 0, 0],
      north = [0, c, s],
      up = [0, -s, c]
    const sfm = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3] * k,
        y = pos[i * 3 + 1] * k,
        z = pos[i * 3 + 2] * k
      for (let a = 0; a < 3; a++) sfm[i * 3 + a] = origin[a] + x * east[a] + y * north[a] + z * up[a]
    }
    const frame = frameFromScaledLocal(makeFrame({ origin, east, north, up }), 20)
    return { pos, sfm, count, truth, frame }
  }

  it('classifies in the product frame, with thresholds in metres', () => {
    const { pos, sfm, count, frame } = tiltedScene()
    const direct = classifyGround(pos, count, { clothResolution: 1 })
    const framed = classifyCloudGround({ count, pos: sfm }, frame, { clothResolution: 1, extent: 'all' })
    let diff = 0
    for (let i = 0; i < count; i++) if (direct.classes[i] !== framed.classes[i]) diff++
    // Float32 storage moves points by ~1e-6 m; only cell-edge points may differ.
    expect(diff).toBeLessThan(count * 2e-3)
  })

  it('converts metre settings into feet for a feet frame', () => {
    const { pos, count } = scene({ step: 0.5, seed: 6 })
    const ft = 0.3048
    const inFeet = pos.map((v) => v / ft)
    const logs = []
    const m = classifyCloudGround({ count, pos }, null, { clothResolution: 1, extent: 'all' })
    const f = classifyCloudGround({ count, pos: inFeet }, null, {
      clothResolution: 1,
      extent: 'all',
      metresPerUnit: ft,
      unitLabel: 'ft',
      onLog: (x) => logs.push(x),
    })
    expect(f.cloth.res).toBeCloseTo(1 / ft, 6)
    expect(Math.abs(f.counts.ground - m.counts.ground)).toBeLessThan(count * 2e-3)
    expect(logs.some((x) => / ft\b/.test(x))).toBe(true)
  })

  it('refuses a cloud over the memory budget', () => {
    expect(() =>
      classifyCloudGround({ count: 1000, pos: new Float32Array(3000) }, null, { budgetBytes: 1000 }),
    ).toThrow(/memory budget/)
  })
})

describe('classifyGround on steep ground', () => {
  // A V-shaped valley with steep flanks: a stiff cloth settles below the flanks and
  // only the slope post-processing (terrain continuity) brings it onto them.
  function valley(grade) {
    const xyz = []
    for (let x = 0; x <= 120; x += 0.5) for (let y = 0; y <= 60; y += 0.5) xyz.push(x, y, grade * Math.abs(x - 60))
    return { pos: Float64Array.from(xyz), count: xyz.length / 3 }
  }

  it('follows 25 % flanks with slope smoothing and leaves them without', () => {
    const { pos, count } = valley(0.25)
    const on = classifyGround(pos, count, { clothResolution: 1, slopeSmoothing: true })
    const off = classifyGround(pos, count, { clothResolution: 1, slopeSmoothing: false })
    expect(on.counts.ground / count).toBeGreaterThan(0.99)
    expect(off.counts.ground / count).toBeLessThan(0.9)
    expect(on.snapped).toBeGreaterThan(0)
  })

  it('does not spread onto a roof across its walls', () => {
    const xyz = []
    for (let x = 0; x <= 60; x += 0.5) {
      for (let y = 0; y <= 60; y += 0.5) {
        const roof = x >= 20 && x <= 40 && y >= 20 && y <= 40
        xyz.push(x, y, 0.2 * x + (roof ? 6 : 0))
      }
    }
    const pos = Float64Array.from(xyz),
      count = xyz.length / 3
    const res = classifyGround(pos, count, { clothResolution: 1 })
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3],
        y = pos[i * 3 + 1]
      if (x > 21 && x < 39 && y > 21 && y < 39) expect(res.classes[i]).toBe(CLASS_UNCLASSIFIED)
    }
  })
})
