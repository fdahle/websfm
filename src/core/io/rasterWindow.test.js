import { expect, it } from 'vitest'
import { rasterWindow, windowToNative } from './rasterWindow.js'
it('clips a window and returns the exact pixel back-map for rounded output sizes', () => {
  expect(rasterWindow({ width: 100, height: 80, bands: 3 }, { col: -5, row: 10, width: 60, height: 30 }, 20, [2])).toEqual({ window: [0,10,55,40], width: 20, height: 11, col: 0, row: 10, scaleX: 2.75, scaleY: 30/11 })
})
it('rejects unbounded output, invalid bands and disjoint windows', () => {
  const meta = { width: 10000, height: 10000, bands: 6 }
  expect(() => rasterWindow(meta, {}, 9000)).toThrow()
  expect(() => rasterWindow(meta, {}, 2048, [6])).toThrow()
  expect(() => rasterWindow(meta, { col: 11000 }, 100)).toThrow()
  expect(() => rasterWindow(meta, {}, 4096, [0,1])).toThrow()
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
