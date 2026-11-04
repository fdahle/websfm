import { describe, it, expect } from 'vitest'
import {
  planImageDetection,
  planDetection,
  plannedTileSize,
  detectionLimits,
  LEARNED_AUTO_TILE_MAX,
} from './detectPlan.js'
import { autoTileSize } from './tiling.js'

const sift = (extra = {}) => ({
  detector: 'sift',
  maxDim: 2400,
  maxDimMode: 'absolute',
  tiling: 'off',
  overlap: 64,
  ...extra,
})

describe('planImageDetection — resize happens before tiling', () => {
  it('reduces a large scan to the detection resolution, keeping aspect', () => {
    const p = planImageDetection(10000, 7500, sift())
    expect(p).toMatchObject({ width: 2400, height: 1800, tiles: 1 })
    expect(p.scale).toBeCloseTo(0.24, 6)
  })

  it('never enlarges a small image', () => {
    expect(planImageDetection(1600, 1200, sift())).toMatchObject({ width: 1600, height: 1200, scale: 1 })
  })

  it('tiles the RESIZED raster, not the native one', () => {
    // 10000 px native would need many 1024 px tiles; the 2400×1800 detection
    // image needs 3×2. This is the order-of-operations point of the module.
    const p = planImageDetection(10000, 7500, sift({ tiling: 'manual', tileSize: 1024 }))
    expect([p.tilesX, p.tilesY]).toEqual([3, 2])
  })

  it('does not tile when the detection image fits in one tile', () => {
    const p = planImageDetection(10000, 7500, sift({ tiling: 'auto' }))
    expect(autoTileSize({ maxBindingBytes: 0 })).toBeGreaterThanOrEqual(1536)
    expect(p.tiles).toBe(2 * 2) // 2400 > 1536 ⇒ split
    const q = planImageDetection(10000, 7500, sift({ tiling: 'auto', maxDim: 1400 }))
    expect(q.tiles).toBe(1)
  })

  it('follows the auto resolution rule', () => {
    // 40 % of 10000 = 4000, inside the medium SIFT band [2400, 4000].
    const p = planImageDetection(10000, 7500, sift({ maxDimMode: 'auto', preset: 'medium' }))
    expect(p.width).toBe(4000)
  })
})

describe('plannedTileSize', () => {
  it('is exact for manual and SIFT auto, an upper bound for a learned auto', () => {
    expect(plannedTileSize(sift({ tiling: 'manual', tileSize: 900 }))).toEqual({ size: 900, exact: true })
    expect(plannedTileSize(sift({ tiling: 'auto' })).exact).toBe(true)
    expect(plannedTileSize({ detector: 'disk', tiling: 'auto' })).toEqual({ size: LEARNED_AUTO_TILE_MAX, exact: false })
    expect(plannedTileSize(sift()).size).toBe(0)
  })
})

describe('planDetection', () => {
  it('summarises a mixed set around its largest image', () => {
    const plan = planDetection(
      [
        { width: 4000, height: 3000 },
        { width: 2000, height: 1500 },
        { width: undefined, height: undefined },
        { width: 10000, height: 7500 },
      ],
      sift({ tiling: 'manual', tileSize: 1024 }),
    )
    expect(plan).toMatchObject({ count: 3, unknown: 1, downscaled: 2, minDetect: 2000, maxDetect: 2400, tiled: 3 })
    expect(plan.largest.natW).toBe(10000)
  })

  it('is null until an image has a size', () => {
    expect(planDetection([{}], sift())).toBeNull()
  })
})

describe('detectionLimits', () => {
  const sizes = [
    { width: 6000, height: 4000 }, // 24 MP
    { width: 20000, height: 20000 }, // 400 MP native
  ]
  it('asks for tiling when SIFT would hold a large image in one piece', () => {
    const p = planDetection(sizes, { maxDim: 12000, tiling: 'off' })
    expect(p.onePass).toEqual({ count: 1, largest: { width: 12000, height: 12000 } })
    expect(p.tooLarge.count).toBe(0)
    // Tiled, or a learned detector (it tiles for the GPU): nothing to say.
    expect(planDetection(sizes, { maxDim: 12000, tiling: 'on' }).onePass.count).toBe(0)
    expect(planDetection(sizes, { maxDim: 12000, tiling: 'off', detector: 'disk' }).onePass.count).toBe(0)
    // At the default resolution every image fits one pass.
    expect(planDetection(sizes, { maxDim: 2400, tiling: 'off' }).onePass.count).toBe(0)
  })
  it('names images whose resized raster cannot exist, whatever the tiling', () => {
    const p = planDetection(sizes, { maxDim: 20000, tiling: 'on' })
    expect(p.tooLarge).toEqual({ count: 1, largest: { width: 20000, height: 20000 } })
    // Not counted twice: tiling cannot help those.
    expect(planDetection(sizes, { maxDim: 20000, tiling: 'off' }).onePass.count).toBe(0)
  })
  it('takes its limits as given', () => {
    const plans = sizes.map((s) => planImageDetection(s.width, s.height, { maxDim: 6000 }))
    expect(detectionLimits(plans, {}, { onePassPx: 10e6 }).onePass.count).toBe(2)
    expect(detectionLimits(plans, {}, { maxSidePx: 5000 }).tooLarge.count).toBe(2)
  })
})
