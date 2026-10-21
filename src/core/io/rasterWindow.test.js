import { expect, it } from 'vitest'
import { rasterWindow, windowToNative, overviewLayout, levelFactor } from './rasterWindow.js'
it('clips a window and returns the exact pixel back-map for rounded output sizes', () => {
  expect(
    rasterWindow({ width: 100, height: 80, bands: 3 }, { col: -5, row: 10, width: 60, height: 30 }, 20, [2]),
  ).toEqual({ window: [0, 10, 55, 40], width: 20, height: 11, col: 0, row: 10, scaleX: 2.75, scaleY: 30 / 11 })
})
it('rejects unbounded output, invalid bands and disjoint windows', () => {
  const meta = { width: 10000, height: 10000, bands: 6 }
  expect(() => rasterWindow(meta, {}, 9000)).toThrow()
  expect(() => rasterWindow(meta, {}, 2048, [6])).toThrow()
  expect(() => rasterWindow(meta, { col: 11000 }, 100)).toThrow()
  expect(() => rasterWindow(meta, {}, 4096, [0, 1])).toThrow()
})
it('maps working samples to the centres of the native pixels nearest resampling read', () => {
  // A 10980-px Sentinel-2 row read at 1536 samples: geotiff takes sample j from
  // native pixel round(j·rel). The mapping must land within half a native pixel of
  // that pixel's centre with no systematic drift — the area convention drifts by
  // (rel − 1)/2 ≈ 3 px everywhere.
  const layout = rasterWindow({ width: 10980, height: 10980, bands: 1 }, {}, 1536, [0])
  let drift = 0
  for (let j = 0; j < layout.width; j++) {
    const [x] = windowToNative(layout, j, 0)
    const centre = Math.min(Math.round(layout.scaleX * j), 10979) + 0.5
    expect(Math.abs(x - centre)).toBeLessThanOrEqual(0.5 + 1e-9)
    drift += x - centre
  }
  expect(Math.abs(drift / layout.width)).toBeLessThan(0.05)
  expect(windowToNative({ col: 4, row: 7, scaleX: 1, scaleY: 1 }, 0, 0)).toEqual([4.5, 7.5])
})

it('reads a downsampled window from the coarsest overview that still has its sampling', () => {
  const levels = [
    { width: 10000, height: 8000 },
    { width: 5000, height: 4000 },
    { width: 2500, height: 2000 },
    { width: 1250, height: 1000 },
  ]
  const layout = rasterWindow(
    { ...levels[0], bands: 4 },
    { col: 1000, row: 2000, width: 4000, height: 4000 },
    1000,
    [0],
  )
  const o = overviewLayout(layout, levels)
  // 4 native px per sample: the ¼ level, read 1:1.
  expect(o).toMatchObject({
    level: 2,
    levelWindow: [250, 500, 1250, 1500],
    scaleX: 4,
    scaleY: 4,
    centreX0: 1002,
    centreY0: 2002,
  })
  // Sample j is level pixel 250 + j, whose centre is native 4·(250 + j + ½).
  expect(windowToNative(o, 10, 3)).toEqual([4 * 260.5, 4 * 503.5])
  // A full-resolution read never moves off level 0.
  expect(
    overviewLayout(rasterWindow({ ...levels[0], bands: 4 }, { width: 500, height: 500 }, 1000, [0]), levels),
  ).toMatchObject({ level: 0 })
  // GDAL ceils overview sizes: 1001 → 501 is still a halving.
  expect(levelFactor({ width: 1001, height: 999 }, { width: 501, height: 500 })).toEqual([2, 2])
})
