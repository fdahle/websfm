import { expect, it } from 'vitest'
import { rasterWindow } from './rasterWindow.js'
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
