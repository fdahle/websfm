import { describe, it, expect } from 'vitest'
import proj4 from 'proj4'
import { warpGrid, warpSourceCoords, sourceWindow, sampleHeightsWarp, sampleRgbaWarp } from './warp.js'

const UTM32 = '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs'
const UTM33 = '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs'

// A plane z = a·x + b·y + c over a grid, NaN in its left column.
function planeDem(src, a, b, c) {
  const data = new Float32Array(src.width * src.height)
  for (let r = 0; r < src.height; r++)
    for (let col = 0; col < src.width; col++) {
      const x = src.originX + (col + 0.5) * src.gsd,
        y = src.originY - (r + 0.5) * src.gsd
      data[r * src.width + col] = col === 0 ? NaN : a * (x - src.originX) + b * (y - src.originY) + c
    }
  return data
}
function warpWhole(src, data, forward, inverse, sample, perCell) {
  const out = warpGrid(src, forward)
  const { sx, sy } = warpSourceCoords(out, src, inverse, 0, 0, out.width, out.height)
  const win = sourceWindow(sx, sy, src)
  const ww = win.x1 - win.x0,
    wh = win.y1 - win.y0
  const window = new data.constructor(ww * wh * perCell)
  for (let r = 0; r < wh; r++)
    window.set(
      data.subarray(((win.y0 + r) * src.width + win.x0) * perCell, ((win.y0 + r) * src.width + win.x1) * perCell),
      r * ww * perCell,
    )
  const res = new data.constructor(out.width * out.height * perCell)
  sample(window, ww, wh, win.x0, win.y0, sx, sy, res)
  return { out, res, sx, sy }
}

describe('raster warp', () => {
  const src = { width: 60, height: 40, gsd: 2, originX: 500000, originY: 5300000 }

  it('is the identity for an identity transform', () => {
    const id = (x, y) => [x, y]
    const data = planeDem(src, 0.1, -0.05, 300)
    const { out, res, sx } = warpWhole(src, data, id, id, sampleHeightsWarp, 1)
    expect(out).toMatchObject({ width: 60, height: 40, gsd: 2, originX: src.originX, originY: src.originY })
    expect(sx[0]).toBeCloseTo(0, 9)
    for (let i = 0; i < data.length; i++) {
      if (Number.isNaN(data[i])) expect(res[i]).toBeNaN()
      else expect(res[i]).toBeCloseTo(data[i], 4)
    }
  })

  it('keeps a shifted grid cell for cell', () => {
    const fwd = (x, y) => [x + 1000, y - 400],
      inv = (x, y) => [x - 1000, y + 400]
    const data = planeDem(src, 0.2, 0.1, 50)
    const { out, res } = warpWhole(src, data, fwd, inv, sampleHeightsWarp, 1)
    expect(out.originX).toBeCloseTo(src.originX + 1000, 6)
    expect(res[5 * 60 + 7]).toBeCloseTo(data[5 * 60 + 7], 4)
  })

  it('warps UTM 32 → 33 (neighbouring zone): a planar surface stays on its plane, nodata stays nodata', () => {
    // Near the zone edge (9° E is 32's centre; 12° E is the border), so the zones' grids are rotated.
    const s = { width: 200, height: 150, gsd: 5, originX: 690000, originY: 5340000 }
    const fwd = (x, y) => proj4(UTM32, UTM33, [x, y]),
      inv = (x, y) => proj4(UTM33, UTM32, [x, y])
    const a = 0.01,
      b = -0.02,
      c = 400
    const data = planeDem(s, a, b, c)
    const { out, res, sx, sy } = warpWhole(s, data, fwd, inv, sampleHeightsWarp, 1)
    // Same ground cell size (the scale factors of the two zones differ a little here).
    expect(out.gsd).toBeGreaterThan(4.98)
    expect(out.gsd).toBeLessThan(5.02)
    let checked = 0
    for (let i = 0; i < res.length; i += 37) {
      const u = sx[i],
        v = sy[i]
      if (!(u >= 1.5 && v >= 0.5 && u <= s.width - 1.5 && v <= s.height - 1.5)) continue
      // Inside the source (and off its NaN column): on the plane at the mapped position.
      const x = (u + 0.5) * s.gsd,
        y = -(v + 0.5) * s.gsd
      expect(res[i]).toBeCloseTo(a * x + b * y + c, 3)
      checked++
    }
    expect(checked).toBeGreaterThan(200)
    // Outside the source footprint (the output box's corners): nodata.
    expect(res[0]).toBeNaN()
  })

  it('round-trips a position UTM 32 → 33 → 32 within a fraction of a cell', () => {
    const fwd = (x, y) => proj4(UTM32, UTM33, [x, y]),
      inv = (x, y) => proj4(UTM33, UTM32, [x, y])
    const s = { width: 100, height: 100, gsd: 1, originX: 690000, originY: 5340000 }
    const out = warpGrid(s, fwd)
    const { sx, sy } = warpSourceCoords(out, s, inv, 0, 0, out.width, out.height)
    // The output cell nearest a source cell's centre maps back onto that centre.
    const [tx, ty] = fwd(s.originX + 50.5, s.originY - 50.5)
    const col = Math.floor((tx - out.originX) / out.gsd),
      row = Math.floor((out.originY - ty) / out.gsd)
    expect(Math.abs(sx[row * out.width + col] - 50)).toBeLessThan(0.75)
    expect(Math.abs(sy[row * out.width + col] - 50)).toBeLessThan(0.75)
  })

  it("keeps an orthophoto's transparency and blends only between opaque cells", () => {
    const s = { width: 4, height: 1, gsd: 1, originX: 0, originY: 1 }
    const rgba = Uint8ClampedArray.of(0, 0, 0, 0, 100, 0, 0, 255, 200, 0, 0, 255, 0, 0, 0, 0)
    const out = new Uint8ClampedArray(4 * 4)
    // Positions: between cells 1 and 2 (both opaque), between 0 and 1 (one transparent), on cell 3.
    sampleRgbaWarp(rgba, 4, 1, 0, 0, Float64Array.of(1.5, 0.4, 3, -3), Float64Array.of(0, 0, 0, 0), out)
    expect([...out.subarray(0, 4)]).toEqual([150, 0, 0, 255])
    expect(out[4 + 3]).toBe(0) // nearest is the transparent cell 0
    expect(out[8 + 3]).toBe(0) // cell 3 is transparent
    expect(out[12 + 3]).toBe(0) // outside
  })

  it('refines the lattice where interpolation would miss', () => {
    const s = { width: 64, height: 64, gsd: 1, originX: 0, originY: 64 }
    // A strongly curved mapping: the lattice must step down.
    const swirl = (x, y) => [x + 8 * Math.sin(y / 3), y + 8 * Math.sin(x / 3)]
    const out = { width: 64, height: 64, gsd: 1, originX: 0, originY: 64 }
    const { step } = warpSourceCoords(out, s, swirl, 0, 0, 64, 64, { step: 16, tol: 0.1 })
    expect(step).toBeLessThan(16)
  })
})
