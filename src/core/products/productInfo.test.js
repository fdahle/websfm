import { describe, expect, it } from 'vitest'
import {
  cloudInfo,
  rasterInfo,
  referenceRasterInfo,
  vectorSetInfo,
  sensorInfo,
  gcpInfo,
  matchesInfo,
} from './productInfo.js'

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

describe('referenceRasterInfo', () => {
  const dem = {
    name: 'REMA.tif',
    kind: 'dem',
    crs: 'EPSG:3031',
    width: 400,
    height: 200,
    geoTransform: { scaleX: 2, scaleY: -2 },
    bands: 1,
    bitsPerSample: [32],
    zMin: 12.5,
    zMax: 840.25,
    verticalDatum: 'unknown',
    horizontalAccuracy: 1.5,
    importedAt: Date.UTC(2026, 9, 29),
  }

  it('lists the grid, the elevations and an unknown datum', () => {
    const info = referenceRasterInfo(dem)
    expect(info.title).toBe('REMA.tif')
    expect(value(info, 'Type')).toBe('Reference DEM')
    expect(value(info, 'Source')).toBe('Imported file')
    expect(value(info, 'Size')).toBe('400 × 200 px')
    expect(value(info, 'Bands')).toBe('1 × 32-bit')
    expect(value(info, 'Elevation')).toBe('12.500 – 840.25')
    expect(value(info, 'Vertical datum')).toBe('Unknown')
    expect(value(info, 'σ horizontal')).toBe('1.50 m')
    expect(value(info, 'Imported')).toBeTruthy()
  })

  it('says a Sentinel-2 window was fetched, and has no DEM rows for an ortho', () => {
    const info = referenceRasterInfo({ ...dem, kind: 'ortho', origin: 'sentinel2' })
    expect(value(info, 'Type')).toBe('Reference orthophoto')
    expect(value(info, 'Source')).toBe('Fetched from Sentinel-2 (Find GCPs)')
    expect(value(info, 'Elevation')).toBeUndefined()
  })
})

describe('vectorSetInfo', () => {
  it('counts polygons, vertices and image links, and spans their extent', () => {
    const set = {
      name: 'outlines.shp',
      source: 'imported',
      sourceCrs: 'EPSG:4326',
      footprints: [
        {
          imageId: 'a',
          rings: [
            [
              [0, 0],
              [10, 0],
              [10, 5],
              [0, 5],
            ],
          ],
        },
        {
          imageId: null,
          rings: [
            [
              [2, 2],
              [3, 2],
              [3, 3],
            ],
          ],
        },
      ],
    }
    const info = vectorSetInfo(set, { crs: 'EPSG:4326' })
    expect(value(info, 'Type')).toBe('Polygons')
    expect(value(info, 'Source')).toBe('Imported file')
    expect(value(info, 'Polygons')).toBe('2')
    expect(value(info, 'Vertices')).toBe('7')
    expect(value(info, 'Linked to images')).toBe('1 of 2')
    expect(value(info, 'Extent')).toBe('10.00 ° × 5.000 °')
    // Imported in the project CRS: no separate "Imported in" row.
    expect(value(info, 'Imported in')).toBeUndefined()
  })

  it('names the contour levels of a line layer', () => {
    const set = {
      name: 'Contours',
      source: 'computed',
      kind: 'lines',
      footprints: [
        {
          level: 100,
          lines: [
            [
              [0, 0],
              [1, 1],
            ],
          ],
        },
        {
          level: 110,
          lines: [
            [
              [0, 1],
              [1, 2],
            ],
          ],
        },
        {
          level: 100,
          lines: [
            [
              [5, 5],
              [6, 6],
            ],
          ],
        },
      ],
    }
    const info = vectorSetInfo(set, {})
    expect(value(info, 'Source')).toBe('Contours from the DEM')
    expect(value(info, 'Lines')).toBe('3')
    expect(value(info, 'Levels')).toBe('100 – 110 (2 levels)')
    expect(value(info, 'Linked to images')).toBeUndefined()
  })
})

describe('sensorInfo', () => {
  it('lists the calibration and its non-zero coefficients', () => {
    const s = { label: 'DJI FC6310', source: 'exif', width: 5472, height: 3648, focal: 8.8, focalUnit: 'mm' }
    const info = sensorInfo({ ...s, cx: 2736, cy: 1824, k1: -0.012, k2: 0 }, { imageCount: 42, lens: 'Radial (k1)' })
    expect(info.title).toBe('DJI FC6310')
    expect(value(info, 'Source')).toBe('EXIF')
    expect(value(info, 'Images')).toBe('42')
    expect(value(info, 'Focal length')).toBe('8.8 mm')
    expect(value(info, 'Lens')).toBe('Radial (k1)')
    expect(value(info, 'Coefficients')).toBe('k1 -0.0120')
    expect(value(info, 'Calibration')).toBeUndefined()
  })

  it('flags an incomplete calibration', () => {
    const info = sensorInfo({ label: 'Scan', source: 'imported', focal: null }, { incomplete: true })
    expect(value(info, 'Focal length')).toBe('Not set')
    expect(value(info, 'Calibration')).toMatch(/Incomplete/)
  })
})

describe('gcpInfo', () => {
  const gcp = {
    name: 'GCP 1',
    role: 'check',
    x: 500123.456,
    y: 6100456.789,
    z: 45.2,
    accuracyX: 0.02,
    accuracyY: 0.02,
    accuracyZ: 0.05,
    observations: [{ imageId: 'a' }, { imageId: 'b' }],
  }

  it('lists the surveyed position, its σ and the residual', () => {
    const report = {
      dx: 0.01,
      dy: -0.02,
      dz: 0.03,
      dTotal: 0.0374,
      sfm: { x: 1, y: 2, z: 3 },
      observations: [{ reprojPx: 0.5 }, { reprojPx: 1.5 }],
    }
    const info = gcpInfo(gcp, { crs: 'EPSG:25832', report })
    expect(value(info, 'Type')).toBe('Checkpoint')
    expect(value(info, 'X')).toBe('500123.46')
    expect(value(info, 'Z')).toBe('45.200000')
    expect(value(info, 'Marked images')).toBe('2')
    expect(value(info, 'Reprojection error')).toBe('1.00 px (mean)')
    expect(value(info, 'Residual X / Y / Z')).toBe('0.0100 / -0.0200 / 0.0300')
    expect(value(info, 'Triangulated')).toBe('Yes')
  })

  it('gives a marker no surveyed rows', () => {
    const info = gcpInfo({ name: 'M1', role: 'marker', observations: [{}] }, {})
    expect(value(info, 'Type')).toBe('Marker (scale-bar endpoint)')
    expect(value(info, 'X')).toBeUndefined()
    expect(value(info, 'Marked images')).toBe('1 (needs at least 2)')
    expect(value(info, 'Triangulated')).toBeUndefined()
  })
})

describe('matchesInfo', () => {
  it('sums the inliers of the verified pairs and counts their images', () => {
    const store = new Map([
      ['a--b', { status: 'done', inlierCount: 100 }],
      ['b--c', { status: 'done', inlierCount: 300 }],
      ['a--c', { status: 'done', inlierCount: 50, enabled: false }],
      ['c--d', { status: 'done', inlierCount: 0 }],
    ])
    const stats = { total: 4, verified: 2, running: 0, error: 0, used: null, excluded: 1, weak: 0 }
    const info = matchesInfo(store, stats, { imageCount: 5 })
    expect(value(info, 'Pairs tried')).toBe('4')
    expect(value(info, 'Verified pairs')).toBe('2')
    expect(value(info, 'Excluded')).toBe('1')
    expect(value(info, 'Used in model')).toBeUndefined()
    expect(value(info, 'Inlier matches')).toBe('400')
    expect(value(info, 'Median per pair')).toBe('300')
    expect(value(info, 'Images in a pair')).toBe('3 of 5 images')
  })
})
