import { describe, expect, it } from 'vitest'
import { planDemWindow, demCogLevels, maskFromNaN } from './demWindow.js'
import { planCogFromTiles } from './geotiff.js'

const dem = { originX: 1000, originY: 5000, fullGsd: 2 }

describe('demCogLevels', () => {
  it("matches the COG writer's levels", () => {
    for (const [w, h] of [
      [16434, 5852],
      [5000, 1200],
      [513, 512],
      [40, 24],
    ]) {
      expect(demCogLevels(w, h, 512)).toEqual(planCogFromTiles({ width: w, height: h, tileSize: 512 }).levels)
    }
  })
})

describe('planDemWindow', () => {
  const levels = demCogLevels(10000, 6000)
  it("reads a small rectangle at full resolution, with its cells' own origin", () => {
    const w = planDemWindow(dem, levels, { minX: 1101, minY: 4801, maxX: 1199, maxY: 4899 }, 1e6)
    expect(w).toEqual({
      level: 0,
      window: [50, 50, 100, 100],
      width: 50,
      height: 50,
      gsd: 2,
      originX: 1100,
      originY: 4900,
    })
  })
  it('steps to the finest level that fits the budget', () => {
    const all = planDemWindow(dem, levels, null, 4096 * 4096)
    expect(all.level).toBe(1)
    expect([all.width, all.height, all.gsd, all.originX, all.originY]).toEqual([5000, 3000, 4, 1000, 5000])
    expect(planDemWindow(dem, levels, null, 1e9).level).toBe(0)
  })
  it('reads the one cell a point lies in, and nothing off the DEM', () => {
    expect(planDemWindow(dem, levels, { minX: 1003, minY: 4997, maxX: 1003, maxY: 4997 }, 1)).toMatchObject({
      window: [1, 1, 2, 2],
    })
    expect(planDemWindow(dem, levels, { minX: 0, minY: 0, maxX: 10, maxY: 10 }, 1e6)).toBeNull()
  })
  it('falls back to the coarsest level when nothing fits', () => {
    expect(planDemWindow(dem, levels, null, 1).level).toBe(levels.length - 1)
  })
})

it('maskFromNaN marks the cells with a height', () => {
  expect([...maskFromNaN(new Float32Array([1, NaN, 0]))]).toEqual([1, 0, 1])
})
