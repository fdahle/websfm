import { describe, it, expect } from 'vitest'
import { sniffCloudFormat, looksLikeXyzText, parseCloudFile, cloudStats, applyImportTransform } from './cloudImport.js'
import { cloudToPly } from '../products/exporters.js'
import { cloudToLas } from './las.js'
import { cloudToXyz } from './cloudText.js'

describe('sniffCloudFormat', () => {
  it('detects LAS/PLY by magic bytes regardless of name', () => {
    expect(sniffCloudFormat(new TextEncoder().encode('LASF'), 'foo.bin')).toBe('las')
    expect(sniffCloudFormat(new TextEncoder().encode('ply\n'), 'foo.dat')).toBe('ply')
  })
  it('falls back to the extension for text formats', () => {
    expect(sniffCloudFormat(new TextEncoder().encode('1 2 3'), 'a.xyz')).toBe('text')
    expect(sniffCloudFormat(new TextEncoder().encode('1 2 3'), 'a.pts')).toBe('text')
    expect(sniffCloudFormat(new TextEncoder().encode('1 2 3'), 'a.las')).toBe('las')
  })
  it('returns null for non-cloud files', () => {
    expect(sniffCloudFormat(new TextEncoder().encode('name,x,y'), 'gcps.csv')).toBeNull()
  })
})

describe('looksLikeXyzText', () => {
  it('accepts bare 3/6/7-column numeric tables', () => {
    expect(looksLikeXyzText('1 2 3\n4 5 6\n')).toBe(true)
    expect(looksLikeXyzText('1 2 3 10 20 30\n4 5 6 40 50 60\n')).toBe(true)
    expect(looksLikeXyzText('1,2,3\n4,5,6\n')).toBe(true)
  })
  it('rejects a 4-column table (ambiguous with numeric-name GCP/pose lists)', () => {
    expect(looksLikeXyzText('1 2 3 4\n5 6 7 8\n')).toBe(false)
  })
  it('rejects header rows and too-few rows', () => {
    expect(looksLikeXyzText('x y z\n1 2 3\n')).toBe(false)
    expect(looksLikeXyzText('1 2 3\n')).toBe(false)
  })
})

describe('parseCloudFile — dispatch', () => {
  const pts = [{ x: 1, y: 2, z: 3, color: [10, 20, 30] }]
  it('routes PLY / LAS / XYZ to the right parser', () => {
    expect(parseCloudFile(cloudToPly(pts), 'a.ply').count).toBe(1)
    expect(parseCloudFile(cloudToLas(pts), 'a.las').count).toBe(1)
    const xyz = new TextEncoder().encode(cloudToXyz(pts)).buffer
    expect(parseCloudFile(xyz, 'a.xyz').count).toBe(1)
  })
  it('throws on an unrecognized format', () => {
    expect(() => parseCloudFile(new TextEncoder().encode('name,x').buffer, 'g.csv')).toThrow(/Unrecognized/)
  })
})

describe('cloudStats', () => {
  it('reports bbox + attributes for a cloud', () => {
    const parsed = { count: 2, pos: Float64Array.from([0, 0, 0, 2, 4, 6]), col: new Uint8Array(6) }
    const s = cloudStats(parsed)
    expect(s.points).toBe(2)
    expect(s.faces).toBe(0)
    expect(s.hasColor).toBe(true)
    expect(s.bbox.max).toEqual([2, 4, 6])
  })
  it('reports vertices + faces for a mesh', () => {
    const parsed = { nVerts: 3, count: 1, pos: Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), idx: Uint32Array.from([0, 1, 2]) }
    const s = cloudStats(parsed)
    expect(s.points).toBe(3)
    expect(s.faces).toBe(1)
  })
})

describe('applyImportTransform', () => {
  it('scales coordinates by unitScale', () => {
    const parsed = { count: 1, pos: Float64Array.from([1000, 2000, 3000]) }
    const out = applyImportTransform(parsed, { unitScale: 0.001 })
    expect([out.pos[0], out.pos[1], out.pos[2]]).toEqual([1, 2, 3])
  })
  it('rotates Y-up → Z-up preserving handedness: (x,y,z) → (x,−z,y)', () => {
    const parsed = { count: 1, pos: Float64Array.from([1, 2, 3]), nrm: Float32Array.from([0, 1, 0]) }
    const out = applyImportTransform(parsed, { swapYZ: true })
    expect([out.pos[0], out.pos[1], out.pos[2]]).toEqual([1, -3, 2])
    // A Y-up normal becomes Z-up (+0 to normalize the -0 the negation produces).
    expect([out.nrm[0] + 0, out.nrm[1] + 0, out.nrm[2] + 0]).toEqual([0, 0, 1])
  })
  it('subsamples a cloud but never a mesh', () => {
    const cloud = { count: 3, pos: Float64Array.from([0, 0, 0, 0.1, 0, 0, 0.2, 0, 0]), col: new Uint8Array(9).fill(100) }
    const outCloud = applyImportTransform(cloud, { subsampleCell: 1 })
    expect(outCloud.count).toBe(1)
    const mesh = { nVerts: 3, count: 1, pos: Float64Array.from([0, 0, 0, 0.1, 0, 0, 0.2, 0, 0]), idx: Uint32Array.from([0, 1, 2]) }
    const outMesh = applyImportTransform(mesh, { subsampleCell: 1 })
    expect(outMesh.nVerts).toBe(3) // untouched
  })
  it('returns the input untouched with default settings', () => {
    const parsed = { count: 1, pos: Float64Array.from([1, 2, 3]) }
    expect(applyImportTransform(parsed, {})).toBe(parsed)
  })
})
