import { describe, expect, it } from 'vitest'
import {
  coregisterDem,
  coregisterDemGrid,
  chainCoregistration,
  coregisteredSimilarity,
  coregistrationAnchors,
  coregistrationMove,
  coregistrationPairs,
  correctionAt,
  sampleDemPoints,
} from './demCoregistration.js'
import { fitSimilarity } from './georef.js'

// Ridged terrain in metres (the reference), and a DEM of it on a 20 m grid displaced
// by `shift`, raised by `bias`, tilted by `tilt` m/km east and north, with noise.
const ref = (x, y) => 400 * Math.sin(x / 700) * Math.cos(y / 900) + 250 * Math.sin((x + 2 * y) / 450)
function makeDem({ shift = [0, 0], bias = 0, tilt = [0, 0], noise = 0, seed = 7 } = {}) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5
  const w = 300,
    h = 300,
    gsd = 20
  const data = new Float32Array(w * h)
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const x = (c + 0.5) * gsd,
        y = 6000 - (r + 0.5) * gsd
      data[r * w + c] =
        ref(x - shift[0], y - shift[1]) + bias + (tilt[0] * (x - 3000) + tilt[1] * (y - 3000)) / 1000 + noise * rnd()
    }
  return { width: w, height: h, gsd, originX: 0, originY: 6000, data }
}

describe('coregisterDem', () => {
  it('recovers the shift, the vertical offset and a tilt', () => {
    const dem = makeDem({ shift: [4, -9], bias: 3, tilt: [0.5, -0.3], noise: 2 })
    const { points, cell } = sampleDemPoints(dem)
    const r = coregisterDem(points, ref, { cell, tilt: 'plane' })
    expect(r.shift[0]).toBeCloseTo(4, 0)
    expect(r.shift[1]).toBeCloseTo(-9, 0)
    // The tilt at the corners: ±(0.5·3 + 0.3·3) m about the centre.
    expect(correctionAt(r, 6000, 0) - correctionAt(r, 3000, 3000)).toBeCloseTo(0.5 * 3 + 0.3 * 3, 0)
    expect(correctionAt(r, 3000, 3000)).toBeCloseTo(3, 0)
    expect(r.after.nmad).toBeLessThan(r.before.nmad / 5)
    expect(Math.abs(r.after.median)).toBeLessThan(0.2)
    expect(r.horizontal.converged).toBe(true)
  })

  it('runs only the steps asked for', () => {
    const dem = makeDem({ shift: [4, -9], bias: 3 })
    const { points, cell } = sampleDemPoints(dem)
    const v = coregisterDem(points, ref, { cell, horizontal: false })
    expect(v.shift).toEqual([0, 0])
    expect(v.horizontal).toBeNull()
    expect(v.tilt).toBeNull()
    const h = coregisterDem(points, ref, { cell, vertical: false })
    expect(h.vertical).toBe(0)
    expect(h.after.median).toBeCloseTo(3, 0) // the offset is left in
  })

  it('fits a quadratic surface', () => {
    const base = makeDem()
    const dem = { ...base, data: base.data.map((z, i) => z + (((i % 300) - 150) / 150) ** 2 * 6) }
    const { points, cell } = sampleDemPoints(dem)
    const plane = coregisterDem(points, ref, { cell, horizontal: false, tilt: 'plane' })
    const quad = coregisterDem(points, ref, { cell, horizontal: false, tilt: 'quadratic' })
    expect(quad.after.nmad).toBeLessThan(0.1)
    expect(plane.after.nmad).toBeGreaterThan(1)
  })

  it('needs overlap, and slopes for the horizontal step', () => {
    const dem = makeDem()
    const { points, cell } = sampleDemPoints(dem)
    expect(coregisterDem(points, () => null, { cell })).toEqual({ error: 'overlap' })
    const flat = { ...dem, data: new Float32Array(dem.data.length).fill(10) }
    const f = sampleDemPoints(flat)
    expect(coregisterDem(f.points, () => 5, { cell: f.cell })).toEqual({ error: 'slopes' })
    expect(coregisterDem(f.points, () => 5, { cell: f.cell, horizontal: false }).vertical).toBe(5)
  })

  it('keeps to the stable ground it is given', () => {
    const dem = makeDem({ bias: 2 })
    // The west half "changed": 30 m lower.
    for (let i = 0; i < dem.data.length; i++) if (i % 300 < 150) dem.data[i] -= 30
    const east = sampleDemPoints(dem, { include: (x) => x > 3100 })
    expect(east.points.every((p) => p.x > 3100)).toBe(true)
    // Half the DEM is stable: the sub-grid is made finer to find about as many cells.
    expect(east.points.length).toBeGreaterThan(15000)
    const r = coregisterDem(east.points, ref, { cell: east.cell, horizontal: false })
    expect(r.vertical).toBeCloseTo(2, 1)
  })
})

describe('coregisterDemGrid', () => {
  it('puts the DEM on the reference', () => {
    const dem = makeDem({ shift: [6, 10], bias: -4, tilt: [0.4, 0.2] })
    const { points, cell } = sampleDemPoints(dem)
    const r = coregisterDem(points, ref, { cell, tilt: 'plane' })
    const out = coregisterDemGrid(dem, r)
    expect(out.originX).toBeCloseTo(-r.shift[0], 6)
    expect(out.originY).toBeCloseTo(6000 - r.shift[1], 6)
    // Every 37th cell now has the reference's height where it lies.
    let worst = 0
    for (let i = 0; i < out.data.length; i += 37) {
      const c = i % 300,
        row = Math.floor(i / 300)
      const x = out.originX + (c + 0.5) * 20,
        y = out.originY - (row + 0.5) * 20
      worst = Math.max(worst, Math.abs(out.data[i] - ref(x, y)))
    }
    expect(worst).toBeLessThan(1.5)
    expect(out.zMin).toBeLessThan(out.zMax)
  })
})

describe('coregisteredSimilarity', () => {
  it('moves an identity georeference by the correction', () => {
    const dem = makeDem({ shift: [5, -3], bias: 2 })
    const { points, cell } = sampleDemPoints(dem)
    const r = coregisterDem(points, ref, { cell })
    const anchors = coregistrationAnchors(points, 50)
    expect(anchors.length).toBeLessThanOrEqual(50)
    const pairs = coregistrationPairs(anchors, r)
    const move = coregistrationMove(pairs)
    expect(move[0]).toBeCloseTo(-r.shift[0], 6)
    expect(move[2]).toBeCloseTo(-r.vertical, 6)
    const moved = coregisteredSimilarity(pairs, { toSfm: (p) => p, fit: fitSimilarity })
    expect(moved.sim.scale).toBeCloseTo(1, 6)
    expect(moved.sim.t[0]).toBeCloseTo(-r.shift[0], 3)
    expect(moved.sim.t[1]).toBeCloseTo(-r.shift[1], 3)
    expect(moved.sim.t[2]).toBeCloseTo(-r.vertical, 3)
  })

  it('takes up a plane as a small rotation', () => {
    const dem = makeDem({ tilt: [2, 0] })
    const { points, cell } = sampleDemPoints(dem)
    const r = coregisterDem(points, ref, { cell, horizontal: false, vertical: false, tilt: 'plane' })
    const moved = coregisteredSimilarity(coregistrationPairs(coregistrationAnchors(points), r), {
      toSfm: (p) => p,
      fit: fitSimilarity,
    })
    // 2 m per km east: the rotation about north is about 2 mrad.
    expect(Math.abs(moved.sim.R[2][0])).toBeCloseTo(0.002, 3)
    expect(Number.isFinite(moved.rms) && moved.rms < 0.5).toBe(true)
  })

  it('adds a second co-registration to the first', () => {
    const anchors = [
      [0, 0, 100],
      [1000, 0, 120],
      [0, 1000, 90],
      [1000, 1000, 110],
    ]
    const first = coregistrationPairs(anchors, { shift: [2, 3], vertical: 1, tilt: null })
    const both = chainCoregistration(first, { shift: [-1, 1], vertical: 0.5, tilt: null })
    expect(both.from).toEqual(anchors)
    expect(coregistrationMove(both)).toEqual([-1, -4, -1.5])
  })
})
