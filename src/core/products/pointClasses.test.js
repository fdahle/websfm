import { describe, it, expect } from 'vitest'
import { classifyCloudGround } from './groundFilter.js'
import { excessGreen } from './pointClasses.js'
import { mulberry32 } from '../sfm/syntheticScene.testutil.js'

// A 60 × 60 m site on a gentle slope: a 12 × 10 m flat-roofed building 7 m high, five
// trees (crowns 4–10 m up), four shrubs (to 2 m) and a car (1.5 m), at a drone
// survey's density (about 200 points per m² on the crowns; UseGeo's MVS cloud has
// 700). Every point carries its true part, so the test reads each class's recall and
// precision.
function scene({ colour = true } = {}) {
  const rng = mulberry32(7)
  const pts = [],
    rgb = [],
    part = []
  const ground = (x, y) => 0.02 * x + 0.01 * y
  const add = (x, y, z, c, p) => {
    pts.push(x, y, z)
    rgb.push(...c)
    part.push(p)
  }
  const jit = (s) => (rng() - 0.5) * 2 * s
  const inBuilding = (x, y) => x > 20 && x < 32 && y > 20 && y < 30
  const brown = [125, 105, 85],
    grey = [150, 148, 145],
    green = [70, 125, 55],
    red = [170, 40, 40]
  for (let x = 0; x < 60; x += 0.2)
    for (let y = 0; y < 60; y += 0.2) if (!inBuilding(x, y)) add(x, y, ground(x, y) + jit(0.02), brown, 'ground')
  const base = ground(26, 25)
  for (let x = 20; x <= 32; x += 0.2)
    for (let y = 20; y <= 30; y += 0.2) add(x, y, base + 7 + jit(0.02), grey, 'building')
  for (let z = 0.6; z < 7; z += 0.2) {
    for (let x = 20; x <= 32; x += 0.2) {
      add(x, 20, base + z, grey, 'building')
      add(x, 30, base + z, grey, 'building')
    }
    for (let y = 20; y <= 30; y += 0.2) {
      add(20, y, base + z, grey, 'building')
      add(32, y, base + z, grey, 'building')
    }
  }
  for (const [tx, ty] of [
    [8, 8],
    [10, 45],
    [45, 10],
    [50, 50],
    [40, 40],
  ]) {
    for (let k = 0; k < 15000; k++) {
      // A crown of radius 3 m around 7 m: a photogrammetric crown is mostly its outer
      // surface, ragged by a metre.
      const u = rng() * 2 - 1,
        th = rng() * 2 * Math.PI,
        r = 3 - rng() * 1.2
      const s = Math.sqrt(1 - u * u)
      const x = tx + r * s * Math.cos(th),
        y = ty + r * s * Math.sin(th)
      add(x, y, ground(tx, ty) + 7 + r * u, green, 'tree')
    }
  }
  for (const [sx, sy] of [
    [15, 50],
    [52, 25],
    [5, 30],
    [35, 52],
  ]) {
    for (let k = 0; k < 2000; k++) {
      const x = sx + jit(1),
        y = sy + jit(1)
      add(x, y, ground(x, y) + 1.2 + jit(0.7), green, 'shrub')
    }
  }
  // A car: a 4 × 1.8 m roof at 1.5 m and its sides.
  for (let x = 40; x <= 44; x += 0.15)
    for (let y = 25; y <= 26.8; y += 0.15) add(x, y, ground(x, y) + 1.5 + jit(0.01), red, 'car')
  for (let z = 0.6; z < 1.5; z += 0.15)
    for (let x = 40; x <= 44; x += 0.15) {
      add(x, 25, ground(x, 25) + z, red, 'car')
      add(x, 26.8, ground(x, 26.8) + z, red, 'car')
    }
  const count = part.length
  return {
    cloud: { count, pos: Float64Array.from(pts), col: colour ? Uint8Array.from(rgb) : null },
    part,
  }
}

function score(classes, part) {
  const tally = {}
  part.forEach((p, i) => {
    tally[p] ??= {}
    tally[p][classes[i]] = (tally[p][classes[i]] ?? 0) + 1
  })
  const share = (p, ...cls) => {
    const t = tally[p] ?? {}
    const n = Object.values(t).reduce((a, b) => a + b, 0)
    return cls.reduce((a, c) => a + (t[c] ?? 0), 0) / n
  }
  // Of everything labelled `cls`, the share that is part `p`.
  const precision = (cls, p) => {
    let all = 0,
      ok = 0
    part.forEach((q, i) => {
      if (classes[i] !== cls) return
      all++
      if (q === p) ok++
    })
    return all ? ok / all : 1
  }
  return { share, precision }
}

describe('classifyAboveGround (Classify Points ▸ vegetation and buildings)', () => {
  for (const colour of [true, false]) {
    it(`labels buildings, trees, shrubs and leaves a car unclassified (${colour ? 'colour' : 'no colour'})`, () => {
      const { cloud, part } = scene({ colour })
      const r = classifyCloudGround(cloud, null, {
        extent: 'all',
        aboveGround: { vegetation: true, buildings: true },
      })
      const { share, precision } = score(r.classes, part)
      expect(r.aboveGround.colour).toBe(colour)
      expect(share('ground', 2)).toBeGreaterThan(0.97)
      expect(share('building', 6)).toBeGreaterThan(0.9)
      expect(precision(6, 'building')).toBeGreaterThan(0.97)
      expect(r.aboveGround.voxel).toBe(0.25)
      expect(share('tree', 5)).toBeGreaterThan(0.8)
      expect(share('shrub', 3, 4)).toBeGreaterThan(0.7)
      expect(share('car', 6)).toBe(0)
      expect(share('car', 3, 4, 5)).toBeLessThan(0.3)
    })
  }

  it('leaves the ground filter result alone when both steps are off', () => {
    const { cloud } = scene()
    const ground = classifyCloudGround(cloud, null, { extent: 'all' })
    const off = classifyCloudGround(cloud, null, {
      extent: 'all',
      aboveGround: { vegetation: false, buildings: false },
    })
    expect(off.classes).toEqual(ground.classes)
    expect(off.aboveGround).toBeUndefined()
  })

  it('finds a roof in a sparse survey: the voxel follows the point spacing', () => {
    // 40 × 40 m at 0.5 m spacing, a 12 m square roof 6 m up (as the browser test's).
    const xyz = []
    for (let x = 0; x <= 40; x += 0.5)
      for (let y = 0; y <= 40; y += 0.5) {
        const roof = x >= 14 && x <= 26 && y >= 14 && y <= 26
        xyz.push(x, y, 0.05 * x + (roof ? 6 : 0))
      }
    const count = xyz.length / 3
    const r = classifyCloudGround({ count, pos: Float64Array.from(xyz), col: null }, null, {
      extent: 'all',
      aboveGround: { vegetation: true, buildings: true },
    })
    expect(r.aboveGround.voxel).toBe(1)
    expect(r.classes.filter((c) => c === 6).length).toBe(25 * 25)
    // Every point's height above the cloth, in metres: the roof stands 6 m up.
    const roofHeights = [...r.heightAboveGround].filter((_, i) => r.classes[i] === 6).sort((a, b) => a - b)
    expect(roofHeights[roofHeights.length >> 1]).toBeCloseTo(6, 1)
    // Ground only still gives the heights.
    const groundOnly = classifyCloudGround({ count, pos: Float64Array.from(xyz), col: null }, null, { extent: 'all' })
    expect(groundOnly.heightAboveGround).toHaveLength(count)
    expect(r.classes.filter((c) => c === 2).length).toBe(81 * 81 - 25 * 25)
  })

  it('reads green from chromatic coordinates', () => {
    expect(excessGreen(70, 125, 55)).toBeGreaterThan(0.2)
    expect(excessGreen(150, 148, 145)).toBeCloseTo(0, 1)
    expect(excessGreen(0, 0, 0)).toBe(0)
  })
})
