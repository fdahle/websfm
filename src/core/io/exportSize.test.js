import { describe, expect, it } from 'vitest'
import { estimateExportBytes } from './exportSize.js'

describe('estimateExportBytes', () => {
  it('is near the written size of a coloured binary PLY cloud', () => {
    // quarry's Low dense cloud: 21,442,726 points, 552 MB written.
    const est = estimateExportBytes({ kind: 'cloud', format: 'ply-binary', points: 21_442_726 })
    expect(est / 552e6).toBeGreaterThan(0.9)
    expect(est / 552e6).toBeLessThan(1.15)
  })
  it('counts vertices and triangles for a mesh, triangles alone for STL', () => {
    expect(estimateExportBytes({ kind: 'mesh', format: 'stl', vertices: 1e6, triangles: 2e6 })).toBe(100e6)
    expect(estimateExportBytes({ kind: 'mesh', format: 'glb', vertices: 1, triangles: 1 })).toBe(28)
  })
  it('falls back to binary PLY for an unknown format', () => {
    expect(estimateExportBytes({ kind: 'cloud', format: 'e57', points: 10 })).toBe(270)
  })
})
