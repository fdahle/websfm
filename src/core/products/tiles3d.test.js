import { describe, it, expect } from 'vitest'
import {
  geodeticToEcef, ecefTransformFromProbes, boundingBox, buildTileset,
  cloudToGlbPoints, localBounds, cloudCentroid,
} from './tiles3d.js'

const norm = (v) => Math.hypot(...v)
const col = (m, i) => [m[i * 4], m[i * 4 + 1], m[i * 4 + 2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('geodeticToEcef', () => {
  it('places (0,0,0) on the +X axis at the equatorial radius', () => {
    const p = geodeticToEcef(0, 0, 0)
    expect(p[0]).toBeCloseTo(6378137, 3)
    expect(p[1]).toBeCloseTo(0, 6)
    expect(p[2]).toBeCloseTo(0, 6)
  })

  it('places the north pole on +Z at the polar radius', () => {
    const p = geodeticToEcef(0, 90, 0)
    expect(p[0]).toBeCloseTo(0, 6)
    expect(p[1]).toBeCloseTo(0, 6)
    expect(p[2]).toBeCloseTo(6356752.314, 2)   // b = a(1−f)
  })

  it('places (90°E, 0) on +Y — the longitude convention', () => {
    const p = geodeticToEcef(90, 0, 0)
    expect(p[1]).toBeCloseTo(6378137, 3)
    expect(p[0]).toBeCloseTo(0, 6)
  })

  it('adds ellipsoidal height along the local normal', () => {
    const a = geodeticToEcef(0, 0, 0)
    const b = geodeticToEcef(0, 0, 1000)
    expect(b[0] - a[0]).toBeCloseTo(1000, 6)
  })
})

// Probes one metre apart in geodetic terms, standing in for what the caller gets
// out of proj4. At the equator 1 m east is 1/111319.49 degrees of longitude.
const M_PER_DEG = 111319.4907932736

describe('ecefTransformFromProbes', () => {
  const origin = { lon: 0, lat: 0, h: 0 }
  const east = { lon: 1 / M_PER_DEG, lat: 0, h: 0 }
  const north = { lon: 0, lat: 1 / 110574.389, h: 0 }   // 1 m north at the equator

  it('puts the ECEF origin in the translation column', () => {
    const m = ecefTransformFromProbes({ origin, east, north })
    expect(col(m, 3)).toEqual(geodeticToEcef(0, 0, 0))
    expect(m[15]).toBe(1)
    // Column-major: the basis columns must have 0 in their w row.
    expect([m[3], m[7], m[11]]).toEqual([0, 0, 0])
  })

  it('builds an orthonormal-to-1m frame at the equator', () => {
    const m = ecefTransformFromProbes({ origin, east, north })
    const [ex, ey, ez] = [col(m, 0), col(m, 1), col(m, 2)]
    for (const v of [ex, ey, ez]) expect(norm(v)).toBeCloseTo(1, 3)
    // At (0,0): east = +Y, north = +Z, up = +X in ECEF.
    expect(ex[1]).toBeCloseTo(1, 3)
    expect(ey[2]).toBeCloseTo(1, 3)
    expect(ez[0]).toBeCloseTo(1, 3)
    expect(dot(ex, ey)).toBeCloseTo(0, 6)
  })

  it('keeps up along the ellipsoid normal even when the grid axes are not square', () => {
    // A deliberately skewed "north" probe — what meridian convergence does to a
    // projected CRS. Up must stay the true vertical rather than absorbing the skew.
    const skewed = { lon: 0.3 / M_PER_DEG, lat: 1 / 110574.389, h: 0 }
    const m = ecefTransformFromProbes({ origin, east, north: skewed })
    const ez = col(m, 2)
    const up = geodeticToEcef(0, 0, 1).map((v, i) => v - geodeticToEcef(0, 0, 0)[i])
    const cos = dot(ez, up) / (norm(ez) * norm(up))
    expect(cos).toBeCloseTo(1, 6)
  })

  it('carries the projection scale factor into the basis length', () => {
    // Probes 1.0004 m apart (a UTM point scale factor): the frame must scale with
    // them, or grid distances render as the wrong ground distance.
    const wide = { lon: 1.0004 / M_PER_DEG, lat: 0, h: 0 }
    const wideN = { lon: 0, lat: 1.0004 / 110574.389, h: 0 }
    const m = ecefTransformFromProbes({ origin, east: wide, north: wideN })
    expect(norm(col(m, 0))).toBeCloseTo(1.0004, 4)
    expect(norm(col(m, 2))).toBeCloseTo(1.0004, 4)
  })

  it('rejects degenerate probes rather than emitting a collapsed frame', () => {
    expect(() => ecefTransformFromProbes({ origin, east: origin, north }))
      .toThrow(/degenerate/)
  })
})

describe('boundingBox', () => {
  it('is centre + three half-axis vectors', () => {
    expect(boundingBox([-2, -4, 0], [2, 4, 10]))
      .toEqual([0, 0, 5, 2, 0, 0, 0, 4, 0, 0, 0, 5])
  })

  it('never produces a zero half-axis for a flat cloud', () => {
    // A perfectly planar DEM-like cloud: a zero-volume box gets culled outright
    // by some readers, so the model would silently never draw.
    const b = boundingBox([0, 0, 5], [10, 10, 5])
    expect(b[11]).toBeGreaterThan(0)
  })
})

describe('buildTileset', () => {
  it('emits a 1.1 tileset with the transform on the root', () => {
    const t = new Array(16).fill(0)
    const ts = buildTileset({ transform: t, box: boundingBox([0, 0, 0], [4, 4, 4]), contentUri: 'content.glb' })
    expect(ts.asset.version).toBe('1.1')
    expect(ts.root.transform).toBe(t)
    expect(ts.root.content.uri).toBe('content.glb')
    expect(ts.root.geometricError).toBe(0)
    expect(ts.geometricError).toBeGreaterThan(0)
    // Content is glTF: no legacy b3dm/pnts container.
    expect(JSON.stringify(ts)).not.toMatch(/b3dm|pnts/)
  })

  it('omits the transform for a local-frame model rather than writing zeros', () => {
    const ts = buildTileset({ transform: null, box: boundingBox([0, 0, 0], [1, 1, 1]), contentUri: 'c.glb' })
    expect('transform' in ts.root).toBe(false)
  })
})

describe('cloudToGlbPoints', () => {
  const cloud = {
    count: 3,
    pos: new Float64Array([0, 0, 0, 10, 20, 30, -5, -5, -5]),
    col: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]),
  }

  function readGlb(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(dv.getUint32(0, true)).toBe(0x46546c67)
    expect(dv.getUint32(8, true)).toBe(bytes.length)
    const jsonLen = dv.getUint32(12, true)
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)))
    const binOff = 20 + jsonLen + 8
    return { json, bin: bytes.subarray(binOff) }
  }

  it('writes a POINTS primitive with no index accessor', () => {
    const { json } = readGlb(cloudToGlbPoints(cloud))
    const prim = json.meshes[0].primitives[0]
    expect(prim.mode).toBe(0)
    expect(prim.indices).toBeUndefined()
    expect(prim.attributes.POSITION).toBe(0)
    expect(prim.attributes.COLOR_0).toBe(1)
    expect(json.accessors[1].normalized).toBe(true)
  })

  it('converts the Z-up tile frame to the Y-up content convention', () => {
    // 3D Tiles rotates glTF content Y-up→Z-up on load, so (E,N,U) must be written
    // as (E,U,−N). Getting this wrong lays the model on its side.
    const { json, bin } = readGlb(cloudToGlbPoints(cloud))
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    // Point 1 is (E,N,U) = (10,20,30) → (10, 30, −20).
    expect(dv.getFloat32(12, true)).toBeCloseTo(10, 4)
    expect(dv.getFloat32(16, true)).toBeCloseTo(30, 4)
    expect(dv.getFloat32(20, true)).toBeCloseTo(-20, 4)
    // z spans −N over the three points: −20 (from N=20) up to 5 (from N=−5).
    expect(json.accessors[0].min).toEqual([-5, -5, -20])
    expect(json.accessors[0].max).toEqual([10, 30, 5])
  })

  it('keeps the raw axes when yUp is off', () => {
    const { bin } = readGlb(cloudToGlbPoints(cloud, { yUp: false }))
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    expect(dv.getFloat32(16, true)).toBeCloseTo(20, 4)
    expect(dv.getFloat32(20, true)).toBeCloseTo(30, 4)
  })

  it('subtracts the origin so float32 keeps sub-millimetre precision', () => {
    // Real project coordinates: a polar-stereographic easting is ~7 digits, which
    // float32 quantizes to ~0.5 m. Relative to the origin the same point is exact.
    const far = {
      count: 1,
      pos: new Float64Array([-2_500_000.125, 1_250_000.0625, 1234.5]),
    }
    const origin = [-2_500_000, 1_250_000, 1234]
    const { bin } = readGlb(cloudToGlbPoints(far, { origin, yUp: false }))
    const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength)
    expect(dv.getFloat32(0, true)).toBeCloseTo(-0.125, 6)
    expect(dv.getFloat32(4, true)).toBeCloseTo(0.0625, 6)
    expect(dv.getFloat32(8, true)).toBeCloseTo(0.5, 6)
  })

  it('is 4-byte aligned in every chunk', () => {
    const bytes = cloudToGlbPoints(cloud)
    expect(bytes.length % 4).toBe(0)
    const dv = new DataView(bytes.buffer)
    expect(dv.getUint32(12, true) % 4).toBe(0)
  })
})

describe('localBounds / cloudCentroid', () => {
  const cloud = { count: 2, pos: new Float64Array([0, 0, 0, 10, 20, 30]) }

  it('measures the bbox relative to the origin', () => {
    expect(localBounds(cloud, [5, 10, 15]))
      .toEqual({ min: [-5, -10, -15], max: [5, 10, 15] })
  })

  it('averages the centroid', () => {
    expect(cloudCentroid(cloud)).toEqual([5, 10, 15])
  })

  it('handles an empty cloud without NaN', () => {
    expect(cloudCentroid({ count: 0, pos: new Float64Array(0) })).toEqual([0, 0, 0])
    expect(localBounds({ count: 0, pos: new Float64Array(0) })).toEqual({ min: [0, 0, 0], max: [0, 0, 0] })
  })
})
