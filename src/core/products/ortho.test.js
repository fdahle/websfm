import { describe, it, expect } from 'vitest'
import {
  fillOrthoGaps,
  sampleOrtho,
  orthorectify,
  orthorectifyStreamed,
  affineToSfm,
  orthoCostCeiling,
} from './ortho.js'
import { NO_LABEL } from './orthoWindow.js'
import { filterDepthMapsGeometric } from '../dense/geomFilter.js'
import { makeSampleMap } from '../sfm/displayFrame.js'
import { scaleK } from '../sfm/geometry.js'
import { frameFromSimilarity } from './georef.js'
import { rasterizeDem } from './dem.js'
import { makeFrame } from './projection.js'

// A nadir camera at (cx,cy,H) looking straight down −Z over a flat plane z=0.
// For a horizontal plane every ground point is at camera-depth H, so the depth
// plane is a constant H — a valid synthetic z-buffer. Paints one solid colour.
function nadirMap({ cx, cy, H = 10, fx = 100, size = 100, color = [255, 0, 0], uuid = 'a' }) {
  const R = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  const t = [-cx, cy, H] // t = -R·C
  const K = { fx, fy: fx, cx: size / 2, cy: size / 2 }
  const depth = new Float32Array(size * size).fill(H)
  const cost = new Float32Array(size * size) // all 0
  const rgb = new Uint8Array(size * size * 3)
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = color[0]
    rgb[i * 3 + 1] = color[1]
    rgb[i * 3 + 2] = color[2]
  }
  return { uuid, width: size, height: size, K, R, t, depth, cost, rgb }
}

const identity = makeFrame({ origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1] })

describe('sampleOrtho', () => {
  it('samples the colour of the one view that sees a ground point', () => {
    const m = nadirMap({ cx: 5, cy: 5, color: [10, 200, 30] })
    const rgb = sampleOrtho([5, 5, 0], [m], {})
    expect(rgb).toEqual([10, 200, 30])
  })

  it('rejects an occluded point (stored depth nearer than the cell)', () => {
    const m = nadirMap({ cx: 5, cy: 5, H: 10 })
    // Force the pixel the point projects to (image centre) to read a near depth.
    m.depth[50 * m.width + 50] = 3 // occluder at depth 3 ≪ 10
    expect(sampleOrtho([5, 5, 0], [m], { depthTolRel: 0.02 })).toBeNull()
  })

  it('best-view blend prefers the lower-cost source', () => {
    const red = nadirMap({ cx: 5, cy: 5, color: [255, 0, 0], uuid: 'red' })
    const blue = nadirMap({ cx: 5, cy: 5, color: [0, 0, 255], uuid: 'blue' })
    // Make blue higher-cost at the sampled pixel → red should win.
    blue.cost[50 * blue.width + 50] = 0.9
    red.cost[50 * red.width + 50] = 0.1
    expect(sampleOrtho([5, 5, 0], [blue, red], { blend: 'best' })).toEqual([255, 0, 0])
  })
})

describe('orthorectify', () => {
  it('colours every covered DEM cell from a single nadir view', () => {
    const m = nadirMap({ cx: 5, cy: 5, color: [40, 90, 160] })
    // Flat DEM over [2,8]² (projects to pixels 20..80, safely in-bounds).
    const pts = []
    for (let x = 2; x <= 8; x += 0.5) for (let y = 2; y <= 8; y += 0.5) pts.push({ x, y, z: 0 })
    const dem = rasterizeDem(pts, { gsd: 0.5, fillRadius: 0 })
    const ortho = orthorectify(dem, [m], identity.toSfm, {})
    expect(ortho.width).toBe(dem.width)
    expect(ortho.covered).toBeGreaterThan(0)
    // The first covered cell carries the source colour, alpha 255.
    let found = false
    for (let i = 0; i < dem.width * dem.height; i++) {
      if (ortho.rgba[i * 4 + 3] === 255) {
        expect([ortho.rgba[i * 4], ortho.rgba[i * 4 + 1], ortho.rgba[i * 4 + 2]]).toEqual([40, 90, 160])
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('leaves cells with no visible view transparent', () => {
    // Camera looks at a different area than the DEM → nothing projects in-bounds.
    const m = nadirMap({ cx: 500, cy: 500 })
    const pts = []
    for (let x = 2; x <= 6; x += 0.5) for (let y = 2; y <= 6; y += 0.5) pts.push({ x, y, z: 0 })
    const dem = rasterizeDem(pts, { gsd: 0.5, fillRadius: 0 })
    const ortho = orthorectify(dem, [m], identity.toSfm, {})
    expect(ortho.covered).toBe(0)
  })

  it('labels each sampled cell with the map that coloured it', () => {
    // Two cameras over x = 2 and x = 8; each sees ±5 around itself (H 10, fx 100).
    const west = nadirMap({ cx: 2, cy: 5, uuid: 'west' })
    const east = nadirMap({ cx: 8, cy: 5, uuid: 'east' })
    east.cost.fill(0.5) // west wins wherever both see the cell
    const pts = []
    for (let x = 0; x <= 12; x += 0.5) for (let y = 3; y <= 7; y += 0.5) pts.push({ x, y, z: 0 })
    const dem = rasterizeDem(pts, { gsd: 0.5, fillRadius: 0 })
    const ortho = orthorectify(dem, [west, east], identity.toSfm, { fillRadius: 0 })
    const seen = new Set(ortho.labels)
    expect(seen.has(0) && seen.has(1)).toBe(true)
    for (let i = 0; i < ortho.labels.length; i++) {
      expect(ortho.labels[i] === NO_LABEL).toBe(ortho.rgba[i * 4 + 3] === 0)
    }
    expect(orthorectify(dem, [west, east], identity.toSfm, { blend: 'average' }).labels).toBeNull()
  })
})

describe('orthorectifyStreamed with the source photo (O1)', () => {
  // A nadir camera 10 above (5,5) with a 400 px photo (fx 400, pixel centres at
  // integers) whose depth map is at ¼ resolution and whose own rgb plane is flat
  // grey. One ortho cell = one photo pixel: cell (col,row) lands on photo pixel
  // (col+160, row+160) exactly, so the ortho must reproduce the photo's checker.
  const Kfull = { fx: 400, fy: 400, cx: 199.5, cy: 199.5 }
  const s = 0.25
  const K = scaleK(Kfull, s)
  const map = {
    uuid: 'p',
    width: 100,
    height: 100,
    K,
    R: [
      [1, 0, 0],
      [0, -1, 0],
      [0, 0, -1],
    ],
    t: [-5, 5, 10],
    depth: new Float32Array(100 * 100).fill(10),
    cost: new Float32Array(100 * 100),
    rgb: new Uint8Array(100 * 100 * 3).fill(77),
  }
  const photo = new Uint8ClampedArray(400 * 400 * 4)
  for (let y = 0; y < 400; y++)
    for (let x = 0; x < 400; x++) {
      const o = 4 * (y * 400 + x),
        v = ((x >> 3) + (y >> 3)) % 2 ? 255 : 0
      photo[o] = v
      photo[o + 1] = 255 - v
      photo[o + 2] = 30
      photo[o + 3] = 255
    }
  const grid = {
    width: 80,
    height: 80,
    gsd: 0.025,
    originX: 4,
    originY: 6,
    data: new Float32Array(80 * 80),
    mask: new Uint8Array(80 * 80).fill(1),
  }
  const opts = { fillRadius: 0 }

  it('samples colour from the photo at full resolution through the sample map', async () => {
    const loadImage = async () => ({
      data: photo,
      width: 400,
      height: 400,
      map: makeSampleMap({ K: Kfull, outScale: s, srcScale: 1 }),
    })
    const out = await orthorectifyStreamed(
      grid,
      [map],
      async () => map,
      (p) => p,
      opts,
      () => {},
      loadImage,
    )
    expect(out.sampled).toBe(80 * 80)
    for (const [col, row] of [
      [0, 0],
      [7, 0],
      [8, 0],
      [37, 51],
      [79, 79],
    ]) {
      const o = 4 * (row * 80 + col),
        po = 4 * ((row + 160) * 400 + col + 160)
      expect([out.rgba[o], out.rgba[o + 1], out.rgba[o + 2]]).toEqual([photo[po], photo[po + 1], photo[po + 2]])
    }
  })

  it('tells the loader how many depth-map pixels one ortho cell spans', async () => {
    let seen = null
    await orthorectifyStreamed(
      grid,
      [map],
      async () => map,
      (p) => p,
      opts,
      () => {},
      async (mi, m, perCell) => {
        seen = perCell
        return null
      },
    )
    expect(seen).toBeCloseTo(0.25, 9) // one cell = one photo pixel = ¼ depth-map pixel
  })

  it('without loadImage (or when it returns null) colours from the depth map', async () => {
    for (const loadImage of [null, async () => null]) {
      const out = await orthorectifyStreamed(
        grid,
        [map],
        async () => map,
        (p) => p,
        opts,
        () => {},
        loadImage,
      )
      expect(out.rgba[0]).toBe(77)
      expect(out.rgba[4 * 80 * 80 - 4]).toBe(77)
    }
  })

  it('leaves a cell the photo does not cover uncoloured', async () => {
    // A photo cropped to its left half: cells mapping to x ≥ 200 have no colour.
    const half = { data: photo, width: 200, height: 400, map: makeSampleMap({ K: Kfull, outScale: s, srcScale: 1 }) }
    const out = await orthorectifyStreamed(
      grid,
      [map],
      async () => map,
      (p) => p,
      opts,
      () => {},
      async () => half,
    )
    expect(out.rgba[4 * 39 + 3]).toBe(255) // col 39 → x 199
    expect(out.rgba[4 * 41 + 3]).toBe(0) // col 41 → x 201
  })
})

describe('fillOrthoGaps', () => {
  it('fills interior transparent pixels but not cells outside the surface', () => {
    const width = 3,
      height = 1
    const rgba = new Uint8ClampedArray([20, 40, 60, 255, 0, 0, 0, 0, 0, 0, 0, 0])
    const surface = new Uint8Array([1, 1, 0])
    const filled = fillOrthoGaps(rgba, surface, width, height, 2, 'nearest')
    expect(filled).toBe(1)
    expect(Array.from(rgba.slice(4, 8))).toEqual([20, 40, 60, 255])
    expect(rgba[11]).toBe(0)
  })

  it('does not let newly filled pixels propagate across a large gap', () => {
    const width = 5
    const rgba = new Uint8ClampedArray(width * 4)
    rgba.set([100, 120, 140, 255], 0)
    const filled = fillOrthoGaps(rgba, new Uint8Array(width).fill(1), width, 1, 1, 'nearest')
    expect(filled).toBe(1)
    expect(rgba[7]).toBe(255)
    expect(rgba[11]).toBe(0)
  })
})

describe('affineToSfm', () => {
  it('linearises a georeference similarity at survey coordinates to sub-nanometre', () => {
    const c = Math.cos(0.3),
      s = Math.sin(0.3)
    const frame = frameFromSimilarity(
      {
        scale: 2.5,
        R: [
          [c, -s, 0],
          [s, c, 0],
          [0, 0, 1],
        ],
        t: [5e5, 7e6, 120],
      },
      'EPSG:3031',
    )
    const lo = [4.99e5, 6.999e6, 50],
      hi = [5.01e5, 7.001e6, 400]
    const aff = affineToSfm(frame.toSfm, lo, hi)
    expect(aff).not.toBeNull()
    for (const q of [
      [5.004e5, 7.0003e6, 77],
      [4.995e5, 6.9995e6, 390],
    ]) {
      const d = q.map((v, i) => v - aff.c0[i])
      const want = frame.toSfm(q)
      for (let r = 0; r < 3; r++) {
        expect(aff.P0[r] + aff.A[r * 3] * d[0] + aff.A[r * 3 + 1] * d[1] + aff.A[r * 3 + 2] * d[2]).toBeCloseTo(
          want[r],
          9,
        )
      }
    }
  })

  it('refuses a non-affine transform so the caller falls back to direct calls', () => {
    expect(affineToSfm(([x, y, z]) => [x * x, y, z], [0, 0, 0], [10, 10, 10])).toBeNull()
  })
})

describe('orthoCostCeiling', () => {
  it('is 1 − minNcc when the run applied the cross-view filter, else unknown', () => {
    expect(orthoCostCeiling({ geomConsistency: true, minNcc: 0.1 })).toBeCloseTo(0.9, 12)
    expect(orthoCostCeiling({ geomConsistency: true, minNcc: 0.4 })).toBeCloseTo(0.6, 12)
    expect(orthoCostCeiling({ geomConsistency: false, minNcc: null })).toBeNull()
    expect(orthoCostCeiling({ geomConsistency: true })).toBeNull()
    expect(orthoCostCeiling(null)).toBeNull()
  })

  it('matches the filter: a maxCost at the ceiling removes nothing the filter left', () => {
    const m = nadirMap({ cx: 0, cy: 0 })
    m.cost.fill(0.95) // every pixel above 1 − 0.1
    for (let i = 0; i < m.cost.length; i += 2) m.cost[i] = 0.5
    filterDepthMapsGeometric([m], { minNcc: 0.1 })
    const ceiling = orthoCostCeiling({ geomConsistency: true, minNcc: 0.1 })
    for (let i = 0; i < m.cost.length; i++) {
      if (m.depth[i] > 0) expect(m.cost[i]).toBeLessThanOrEqual(ceiling)
    }
    const pts = [
      [0, 0, 0],
      [1, 1, 0],
      [-2, 3, 0],
      [3.3, -1.7, 0],
      [0.05, 0, 0],
      [1.05, 1, 0],
    ]
    expect(pts.filter((P) => sampleOrtho(P, [m], { maxCost: Infinity })).length).toBeGreaterThan(0)
    for (const P of pts) {
      expect(sampleOrtho(P, [m], { maxCost: ceiling })).toEqual(sampleOrtho(P, [m], { maxCost: Infinity }))
    }
  })
})
