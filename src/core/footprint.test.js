import { describe, it, expect } from 'vitest'
import { opkMatrix, focalPx, projectFootprint, projectPixelToGround, projectFootprintOnTerrain } from './footprint.js'

// A square-pixel nadir sensor: 1000×800 px, 1000 px focal, principal point centred.
const SENSOR = { focal: 1000, cx: 500, cy: 400, width: 1000, height: 800 }

describe('opkMatrix', () => {
  it('is the identity at zero rotation', () => {
    const M = opkMatrix(0, 0, 0)
    const I = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(M[r][c]).toBeCloseTo(I[r][c], 12)
  })

  it('is orthonormal for a non-trivial rotation', () => {
    const M = opkMatrix(12, -7, 33)
    // Rows are unit length and mutually orthogonal.
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    expect(dot(M[0], M[0])).toBeCloseTo(1, 12)
    expect(dot(M[1], M[1])).toBeCloseTo(1, 12)
    expect(dot(M[0], M[1])).toBeCloseTo(0, 12)
    expect(dot(M[1], M[2])).toBeCloseTo(0, 12)
  })
})

describe('focalPx', () => {
  it('passes through a pixel focal', () => {
    expect(focalPx({ focal: 1234, focalUnit: 'px' })).toBe(1234)
  })
  it('converts mm focal via pixel size', () => {
    expect(focalPx({ focal: 50, focalUnit: 'mm', pixelSize: 0.005 })).toBe(10000)
  })
  it('cannot convert a bare EXIF mm focal', () => {
    expect(focalPx({ focal: 35, focalUnit: 'mm', pixelSize: null })).toBeNull()
  })
  it('assumes pixels when no unit is given', () => {
    expect(focalPx({ focal: 900 })).toBe(900)
  })
})

describe('projectFootprint (nadir)', () => {
  // Camera 1000 m above a ground plane at Z=0, looking straight down.
  const pose = { x: 0, y: 0, z: 1000, omega: 0, phi: 0, kappa: 0 }
  const fp = projectFootprint(pose, SENSOR, 0)

  it('returns a closed 4-corner ring', () => {
    expect(fp.error).toBeUndefined()
    expect(fp.rings).toHaveLength(1)
    expect(fp.rings[0]).toHaveLength(5) // 4 corners + repeated first
    expect(fp.rings[0][0]).toEqual(fp.rings[0][4]) // closed
  })

  it('is centred on the camera with the expected ground size', () => {
    // Ground sampling: at height H the half-width = (W/2)/focal * H.
    // Here = 500/1000 * 1000 = 500 m east/west, 400/1000*1000 = 400 m north/south.
    const ring = fp.rings[0]
    const xs = ring.map((p) => p[0])
    const ys = ring.map((p) => p[1])
    expect(Math.min(...xs)).toBeCloseTo(-500, 6)
    expect(Math.max(...xs)).toBeCloseTo(500, 6)
    expect(Math.min(...ys)).toBeCloseTo(-400, 6)
    expect(Math.max(...ys)).toBeCloseTo(400, 6)
  })

  it('puts the principal point directly below the camera', () => {
    const g = projectPixelToGround(500, 400, {
      Mt: opkMatrix(0, 0, 0),
      center: [0, 0, 1000],
      focal: 1000,
      cx: 500,
      cy: 400,
      groundZ: 0,
    })
    expect(g[0]).toBeCloseTo(0, 9)
    expect(g[1]).toBeCloseTo(0, 9)
  })
})

describe('projectFootprint (degenerate cases)', () => {
  const sensor = SENSOR

  it('rejects a camera at or below the ground plane', () => {
    expect(projectFootprint({ x: 0, y: 0, z: 0, omega: 0, phi: 0, kappa: 0 }, sensor, 0).error).toBe('below_plane')
    expect(projectFootprint({ x: 0, y: 0, z: -5, omega: 0, phi: 0, kappa: 0 }, sensor, 0).error).toBe('below_plane')
  })

  it('rejects a missing elevation', () => {
    expect(projectFootprint({ x: 0, y: 0, z: null, omega: 0, phi: 0, kappa: 0 }, sensor, 0).error).toBe('invalid')
  })

  it('rejects an over-tilted view whose corner sees past the horizon', () => {
    // 89° tilt: the far edge of a downward camera looks above the horizon, so the
    // footprint is unbounded and projection diverges.
    const tilted = { x: 0, y: 0, z: 1000, omega: 89, phi: 0, kappa: 0 }
    expect(projectFootprint(tilted, sensor, 0).error).toBe('diverges')
  })

  it('rejects a near-180° FOV (tiny focal) nadir camera instead of spanning the earth', () => {
    // A garbage focal (~2 px for a 1000 px-wide frame) gives a near-180° field of
    // view: the corner rays graze the ground and, unclamped, land tens of
    // thousands of km away. The grazing guard rejects it rather than drawing a
    // footprint that wraps the globe. (Regression: earth-spanning footprints.)
    const wideFov = { ...sensor, focal: 2 }
    const nadir = { x: 0, y: 0, z: 1000, omega: 0, phi: 0, kappa: 0 }
    expect(projectFootprint(nadir, wideFov, 0).error).toBe('diverges')
  })

  it('keeps a normal near-nadir footprint bounded to a sane extent', () => {
    // Sanity companion to the guard: a real nadir camera at 1000 m produces a
    // footprint a few hundred metres across, never continent-scale.
    const nadir = { x: 0, y: 0, z: 1000, omega: 0, phi: 0, kappa: 0 }
    const fp = projectFootprint(nadir, sensor, 0)
    expect(fp.error).toBeUndefined()
    const xs = fp.rings[0].map((p) => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(2000)
  })

  it('shifts the footprint off-nadir under a modest tilt', () => {
    // A 20° omega tilt swings the view off nadir along Y; the centroid leaves the
    // origin (sign follows the omega/phi/kappa convention — here −Y).
    const tilted = { x: 0, y: 0, z: 1000, omega: 20, phi: 0, kappa: 0 }
    const fp = projectFootprint(tilted, sensor, 0)
    expect(fp.error).toBeUndefined()
    const cy = fp.rings[0].slice(0, 4).reduce((s, p) => s + p[1], 0) / 4
    expect(Math.abs(cy)).toBeGreaterThan(100)
  })
})

describe('projectFootprintOnTerrain', () => {
  const nadir = { x: 0, y: 0, z: 1000, omega: 0, phi: 0, kappa: 0 }

  it('matches the plane footprint on flat terrain', async () => {
    const fp = await projectFootprintOnTerrain(nadir, SENSOR, () => 200)
    const plane = projectFootprint(nadir, SENSOR, 200)
    fp.rings[0].forEach((p, i) => {
      expect(p[0]).toBeCloseTo(plane.rings[0][i][0], 6)
      expect(p[1]).toBeCloseTo(plane.rings[0][i][1], 6)
    })
  })

  it('lands each corner on a sloping surface', async () => {
    // Ground rising 0.3 m per metre eastwards: the east corners meet it higher up,
    // so closer to the camera than the plane through the nadir point would put them.
    const heightAt = async (x) => 0.3 * x
    const fp = await projectFootprintOnTerrain(nadir, SENSOR, heightAt)
    expect(fp.error).toBeUndefined()
    for (const [x, y] of fp.rings[0].slice(0, 4)) {
      // On the ray: x = (u − cx)/f · (z_cam − h), with h the terrain under (x, y).
      const h = 0.3 * x
      expect(Math.abs(x)).toBeCloseTo(0.5 * (1000 - h), 0)
      expect(Math.abs(y)).toBeCloseTo(0.4 * (1000 - h), 0)
    }
    const xs = fp.rings[0].map((p) => p[0])
    expect(Math.max(...xs)).toBeLessThan(500) // uphill: shorter
    expect(Math.min(...xs)).toBeLessThan(-500) // downhill: longer
  })

  it('lands on ground rising faster than an oblique ray', async () => {
    // Tilted 40° over ground rising 1:1 towards the far edge, steeper than the far
    // corner's ray: re-reading the height at each plane hit would overshoot past
    // the camera there; the bracketed search still lands on the surface.
    const tilted = { ...nadir, phi: 40 }
    const heightAt = (x, y) => 300 + Math.abs(x) + 0.5 * y
    const fp = await projectFootprintOnTerrain(tilted, SENSOR, heightAt)
    expect(fp.error).toBeUndefined()
    const Mt = (() => {
      const M = opkMatrix(0, 40, 0)
      return M[0].map((_, c) => M.map((r) => r[c]))
    })()
    const corners = [
      [0, 0],
      [1000, 0],
      [1000, 800],
      [0, 800],
    ]
    fp.rings[0].slice(0, 4).forEach(([x, y], i) => {
      // Re-cast the corner onto the plane at the terrain height where it landed.
      const g = projectPixelToGround(...corners[i], {
        Mt,
        center: [0, 0, 1000],
        focal: 1000,
        cx: 500,
        cy: 400,
        groundZ: heightAt(x, y),
      })
      expect(Math.hypot(g[0] - x, g[1] - y)).toBeLessThan(1)
    })
  })

  it('reports a camera below the terrain and a surface with no height', async () => {
    expect((await projectFootprintOnTerrain(nadir, SENSOR, () => 1500)).error).toBe('below_plane')
    expect((await projectFootprintOnTerrain(nadir, SENSOR, () => null)).error).toBe('off_terrain')
    expect((await projectFootprintOnTerrain(nadir, SENSOR, (x) => (x > 100 ? null : 0))).error).toBe('off_terrain')
  })
})
