import { expect, it } from 'vitest'
import { applyHomography } from '../features/guidedTiles.js'
import {
  homographyToNative,
  homographyScale,
  footprintRect,
  searchWindows,
  fineTiles,
  acceptTile,
  invertHomography,
  gpsSearchOutline,
  searchRegion,
  matchConfidence,
  footprintSearchPoints,
} from './referenceMatch.js'

// Rotation by 30°, scale 0.25 (the reference is 4× coarser), translation.
const c = Math.cos(Math.PI / 6),
  s = Math.sin(Math.PI / 6)
const H = [0.25 * c, -0.25 * s, 900, 0.25 * s, 0.25 * c, 400, 0, 0, 1]

it('maps working matches exactly: a point read in both windows lands on its native match', () => {
  const from = { scaleX: 2, scaleY: 2, centreX0: 1, centreY0: 1 },
    to = { col: 300, row: 30, scaleX: 3, scaleY: 3 }
  // Build Hw = A_to⁻¹ · H · A_from, then check homographyToNative(Hw) ≈ H.
  const A = (L) => [L.scaleX, 0, L.centreX0 ?? L.col + 0.5, 0, L.scaleY, L.centreY0 ?? L.row + 0.5, 0, 0, 1]
  const mul = (P, Q) =>
    Array.from({ length: 9 }, (_, k) =>
      [0, 1, 2].reduce((t, m) => t + P[Math.floor(k / 3) * 3 + m] * Q[m * 3 + (k % 3)], 0),
    )
  const Hw = mul(invertHomography(A(to)), mul(H, A(from)))
  const back = homographyToNative(Hw, from, to)
  for (const p of [
    [0, 0],
    [1000, 200],
    [37.5, 812],
  ]) {
    const [x, y] = applyHomography(back, ...p),
      [ex, ey] = applyHomography(H, ...p)
    expect(x).toBeCloseTo(ex, 9)
    expect(y).toBeCloseTo(ey, 9)
  }
})

it('measures the scale between rasters and the footprint the ortho covers', () => {
  expect(homographyScale(H, 500, 500)).toBeCloseTo(0.25, 9)
  const rect = footprintRect(H, 2000, 1000, 5000, 5000, 0)
  // Corners rotated by 30° at ¼: x spans 900 − 0.25·1000·s … 900 + 0.25·2000·c.
  expect(rect.col).toBe(Math.floor(900 - 250 * s))
  expect(rect.width).toBe(Math.ceil(900 + 500 * c) - rect.col)
})

it('subdivides a search region into overlapping windows that cover it', () => {
  const region = { col: 100, row: 0, width: 1000, height: 500 }
  expect(searchWindows(region, 1)).toEqual([region])
  const two = searchWindows(region, 2),
    three = searchWindows(region, 3)
  expect(two).toHaveLength(9)
  expect(three).toHaveLength(25)
  expect(two[8]).toEqual({ col: 600, row: 250, width: 500, height: 250 })
  // Any footprint of ¼ (level 2) or 1/16 (level 3) of the region is whole in a window.
  for (const [windows, f] of [
    [two, 0.25],
    [three, 0.0625],
  ]) {
    for (let i = 0; i <= 100; i++)
      for (let k = 0; k <= 20; k++) {
        const fx0 = 100 + (1000 * (1 - f) * i) / 100,
          fy0 = (500 * (1 - f) * k) / 20
        expect(
          windows.some(
            (w) =>
              w.col <= fx0 && w.col + w.width >= fx0 + 1000 * f && w.row <= fy0 && w.row + w.height >= fy0 + 500 * f,
          ),
        ).toBe(true)
      }
  }
})

it('lays fine tiles at the coarser native resolution and drops empty ones', () => {
  // Reference 4× coarser: tiles are 512 reference px = 2048 ortho px.
  const plan = fineTiles({
    H,
    localWidth: 8000,
    localHeight: 4000,
    refWidth: 5000,
    refHeight: 5000,
    scale: 0.25,
    covered: (x0) => (x0 < 1000 ? 0 : 1),
  })
  expect(plan).toMatchObject({ kl: 4, kr: 1 })
  expect(plan.tiles.map((t) => [t.i, t.j])).toEqual([
    [1, 0],
    [2, 0],
    [3, 0],
    [1, 1],
    [2, 1],
    [3, 1],
  ])
  expect(plan.tiles[0].localMaxDim).toBe(512)
  // The reference rect holds the mapped tile plus the margin.
  const t = plan.tiles[0],
    q = applyHomography(H, t.local.col, t.local.row)
  expect(q[0]).toBeGreaterThanOrEqual(t.reference.col + 32 - 1)
  // A finer reference: the ortho is read at native, the reference downsampled.
  expect(fineTiles({ H, localWidth: 600, localHeight: 600, refWidth: 9000, refHeight: 9000, scale: 3 })).toMatchObject({
    kl: 1,
    kr: 3,
  })
})

it('rejects a tile whose consistent matches are bunched together', () => {
  const pairs = Array.from({ length: 20 }, (_, i) => [100 + (i % 5), 100 + Math.floor(i / 5)])
  const fit = { inlierCount: 20, inlierMask: new Uint8Array(20).fill(1) }
  expect(acceptTile(fit, pairs, { tileSize: 512 })).toBe(false)
  const spread = pairs.map(([x, y], i) => [x + (i % 5) * 60, y + Math.floor(i / 5) * 60])
  expect(acceptTile(fit, spread, { tileSize: 512 })).toBe(true)
  expect(acceptTile({ ...fit, inlierCount: 9 }, spread, { tileSize: 512 })).toBe(false)
})

it('outlines GPS positions with a metric floor and refuses a footprint off the raster', () => {
  const outline = gpsSearchOutline([
    [10, -75],
    [10.0001, -75.0001],
  ])
  const lats = outline.map((p) => p[1]),
    lons = outline.map((p) => p[0])
  // 300 m of latitude ≈ 0.0027°; of longitude at 75° S ≈ 0.0104°.
  expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(0.0001 + (2 * 300) / 111320, 6)
  expect(Math.max(...lons) - Math.min(...lons)).toBeCloseTo(
    0.0001 + (2 * 300) / (111320 * Math.cos((-75.00005 * Math.PI) / 180)),
    6,
  )
  expect(gpsSearchOutline([[10, -75]])).toBeNull()
  expect(
    searchRegion(
      [
        [100, 100],
        [200, 150],
      ],
      4000,
      4000,
    ),
  ).toEqual({ col: 36, row: 36, width: 228, height: 178 })
  expect(
    searchRegion(
      [
        [0, 0],
        [3900, 3900],
      ],
      4000,
      4000,
    ),
  ).toBeNull()
  expect(() =>
    searchRegion(
      [
        [-900, -900],
        [-500, -500],
      ],
      4000,
      4000,
    ),
  ).toThrow(/does not cover/)
})

it('scores confidence from tile agreement, fit residual and track length', () => {
  expect(matchConfidence({ ratio: 1, inliers: 60, residual: 0, observations: 3 })).toBe(1)
  expect(matchConfidence({ ratio: 0.5, inliers: 15, residual: 1, observations: 2 })).toBeCloseTo(
    0.5 * 0.5 * Math.exp(-0.5) * 0.8,
    9,
  )
})

it("footprintSearchPoints takes the outer rings of the registered images' footprints from every polygon set", () => {
  const sets = [
    {
      kind: 'polygons',
      footprints: [
        {
          imageId: 1,
          rings: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
            [[0.2, 0.2]],
          ],
        },
      ],
    },
    { footprints: [{ imageId: 2, rings: [[[5, 5]]] }, { imageId: 3, rings: [[[9, 9]]] }, { rings: [[[7, 7]]] }] },
    { kind: 'lines', footprints: [{ imageId: 1, rings: [[[8, 8]]] }] },
  ]
  expect(footprintSearchPoints(sets, new Set([1, 2]))).toEqual([
    [0, 0],
    [1, 0],
    [1, 1],
    [5, 5],
  ])
})
