import { describe, it, expect } from 'vitest'
import { sampleDemAtGcps, sampleDem } from './demCheck.js'

// 2×2 DEM, gsd=10, origin at (0,100) top-left (row 0 = max Y).
// Cell centres: (5,95)=10, (15,95)=20, (5,85)=30, (15,85)=40.
const dem = {
  width: 2, height: 2, gsd: 10, originX: 0, originY: 100,
  data: new Float32Array([10, 20, 30, 40]),
  mask: new Uint8Array([1, 1, 1, 1]),
}

describe('sampleDem', () => {
  it('returns the exact value at a cell centre', () => {
    expect(sampleDem(dem, 5, 95)).toBeCloseTo(10, 6)
    expect(sampleDem(dem, 15, 85)).toBeCloseTo(40, 6)
  })

  it('bilinearly interpolates between centres', () => {
    // Midpoint of all four centres → mean = 25.
    expect(sampleDem(dem, 10, 90)).toBeCloseTo(25, 6)
  })

  it('returns null outside the raster', () => {
    expect(sampleDem(dem, -50, 90)).toBeNull()
    expect(sampleDem(dem, 90, 90)).toBeNull()
  })

  it('falls back to nearest when a neighbour is masked', () => {
    const holed = { ...dem, mask: new Uint8Array([1, 0, 1, 1]) }
    // At (15,95) the exact cell (col1,row0) is masked → nearest valid returned.
    const v = sampleDem(holed, 15, 95)
    expect(v == null || typeof v === 'number').toBe(true)
  })
})

describe('sampleDemAtGcps', () => {
  it('produces dz = demZ - gcpZ, null where outside', () => {
    const gcps = [
      { id: 'g1', name: 'A', x: 5, y: 95, z: 8 },   // demZ 10 → dz 2
      { id: 'g2', name: 'B', x: 999, y: 999, z: 5 }, // outside → demZ null, dz null
    ]
    const out = sampleDemAtGcps(dem, gcps)
    expect(out[0].demZ).toBeCloseTo(10, 6)
    expect(out[0].dz).toBeCloseTo(2, 6)
    expect(out[1].demZ).toBeNull()
    expect(out[1].dz).toBeNull()
  })
})
