import { describe, expect, it } from 'vitest'
import { cloudInfo, rasterInfo } from './productInfo.js'

const value = (info, label) => info.rows.find((r) => r.label === label)?.value

describe('cloudInfo', () => {
  const sparse = {
    id: 's1',
    name: 'Sparse cloud',
    kind: 'sparse',
    createdAt: Date.UTC(2026, 9, 27),
    cameras: new Map([
      ['a', {}],
      ['b', {}],
    ]),
    // Three points, one without a track; the other two seen in 2 and 4 views.
    points: { length: 3, vcount: Uint32Array.from([2, 0, 4]) },
  }

  it('lists cameras of the images, tie-points and the mean track', () => {
    const info = cloudInfo(sparse, { isMain: true, imageCount: 5, summary: { postBaMedianPx: 0.512 } })
    expect(info.title).toBe('Sparse cloud')
    expect(value(info, 'Type')).toBe('Sparse cloud (main)')
    expect(value(info, 'Cameras')).toBe('2 of 5 images')
    expect(value(info, 'Points')).toBe('3')
    expect(value(info, 'Tie-points')).toBe('2')
    expect(value(info, 'Mean track length')).toBe('3.00 views')
    expect(value(info, 'Reprojection error')).toBe('0.51 px (median)')
    expect(value(info, 'Created')).toBeTruthy()
  })

  it('leaves out what a record does not carry', () => {
    const info = cloudInfo({ ...sparse, createdAt: undefined }, {})
    expect(value(info, 'Reprojection error')).toBeUndefined()
    expect(value(info, 'Created')).toBeUndefined()
    expect(value(info, 'Cameras')).toBe('2')
  })

  it('names how a dense cloud is held', () => {
    const resident = { kind: 'dense', name: 'Dense', count: 1200, pos: new Float32Array(3), col: new Uint8Array(3) }
    expect(value(cloudInfo(resident), 'Storage')).toBe('In memory')
    expect(value(cloudInfo(resident), 'Normals')).toBe('No')
    const copc = { kind: 'dense', name: 'Scan', count: 9, imported: true, lod: { format: 'copc' } }
    expect(value(cloudInfo(copc), 'Storage')).toBe('Read in place from its COPC file')
    expect(value(cloudInfo(copc), 'Type')).toBe('Dense cloud (imported)')
  })

  it('reports a mesh run record', () => {
    const mesh = {
      kind: 'mesh',
      name: 'Mesh',
      count: 10,
      nVerts: 7,
      meshSummary: { sourceName: 'Dense cloud', depth: 8, trim: 'gentle', totalMs: 2500 },
    }
    const info = cloudInfo(mesh)
    expect(value(info, 'Triangles')).toBe('10')
    expect(value(info, 'Source')).toBe('Dense cloud')
    expect(value(info, 'Octree depth')).toBe('8')
    expect(value(info, 'Build time')).toBe('2.5 s')
    expect(value(info, 'Texture')).toBe('No (vertex colours)')
  })
})

describe('rasterInfo', () => {
  it('describes a DEM: frame, extent, source and gap fill', () => {
    const dem = {
      name: 'DEM',
      width: 400,
      height: 200,
      gsd: 0.5,
      crs: 'EPSG:32632',
      unit: 'm',
      zMin: 101.25,
      zMax: 180.5,
      points: 'all',
      fillMethod: 'idw',
      source: { id: 'd1', name: 'Dense cloud', kind: 'dense' },
    }
    const info = rasterInfo('dem', dem)
    expect(value(info, 'Type')).toBe('DEM (surface)')
    expect(value(info, 'Outdated')).toBeUndefined()
    expect(value(info, 'Frame')).toBe('EPSG:32632')
    expect(value(info, 'Size')).toBe('400 × 200 px')
    expect(value(info, 'GSD')).toBe('0.500 m/px')
    expect(value(info, 'Extent')).toBe('200.0 × 100.0 m')
    expect(value(info, 'Source')).toBe('Dense cloud (dense)')
    expect(value(info, 'Gap fill')).toBe('Inverse distance')
    expect(value(info, 'Elevation')).toBe('101.25 – 180.50 m')
  })

  it('names the main one and why it is outdated', () => {
    const info = rasterInfo(
      'dem',
      { width: 1, height: 1, gsd: 1 },
      { isMain: true, outdated: '"Dense" was rebuilt since' },
    )
    expect(value(info, 'Type')).toBe('DEM (surface) (main)')
    expect(value(info, 'Outdated')).toBe('"Dense" was rebuilt since')
    const dense = cloudInfo(
      { kind: 'dense', name: 'D', count: 1 },
      { isMain: true, outdated: 'the sparse model has changed since it was built' },
    )
    expect(value(dense, 'Type')).toBe('Dense cloud (main)')
    expect(value(dense, 'Outdated')).toBe('The sparse model has changed since it was built')
  })

  it('calls a ground-only DEM a DTM, in model units without a CRS', () => {
    const info = rasterInfo('dem', { width: 1, height: 1, gsd: 1, points: 'ground', crs: 'local', unit: 'model' })
    expect(value(info, 'Type')).toBe('DTM (ground only)')
    expect(value(info, 'Frame')).toBe('Local')
    expect(value(info, 'GSD')).toBe('1.00 model units/px')
  })

  it('shows seams and gains for a mosaic only', () => {
    const base = { width: 10, height: 10, gsd: 0.1, unit: 'm', covered: 75, surface: 'DEM' }
    const mosaic = rasterInfo('ortho', {
      ...base,
      method: { blend: 'mosaic', seamline: 'graphcut', colourBalance: true },
    })
    expect(value(mosaic, 'Coverage')).toBe('75%')
    expect(value(mosaic, 'Blend')).toBe('Mosaic')
    expect(value(mosaic, 'Seamlines')).toBe('Graph cut')
    expect(value(mosaic, 'Colour balance')).toBe('On')
    const best = rasterInfo('ortho', { ...base, method: { blend: 'best', seamline: 'graphcut' } })
    expect(value(best, 'Blend')).toBe('Best match')
    expect(value(best, 'Seamlines')).toBeUndefined()
  })
})
