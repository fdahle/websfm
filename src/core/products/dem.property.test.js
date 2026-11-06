import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { cellCenter, rasterizeWindow, fillNodata, fillEnclosedGaps } from './dem.js'

// The DEM's gridding and fills against what they are defined to compute (dem.js), with
// a reference written out here: a cell holds the max / min / mean / median of the points
// that fall in it (top-left origin, cell = floor of the offset over the GSD); IDW fills a
// hole with Σ z/d² ÷ Σ 1/d² over the measured cells within its radius; the enclosed-gap
// fill writes every nodata area that does not reach the border, and only those.

const num = (min, max) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true })
const grid = fc.record({
  width: fc.integer({ min: 1, max: 12 }),
  height: fc.integer({ min: 1, max: 12 }),
  gsd: num(0.05, 20),
  originX: num(-1e5, 1e5),
  originY: num(-1e5, 1e5),
})

describe('rasterizeWindow', () => {
  it('puts a point at a cell centre in that cell', () => {
    fc.assert(
      fc.property(grid, fc.nat(), fc.nat(), num(-100, 4000), (g, c0, r0, z) => {
        const col = c0 % g.width,
          row = r0 % g.height
        const [x, y] = cellCenter(g, col, row)
        const { data, count } = rasterizeWindow([{ x, y, z }], g, { fillRadius: 0 })
        expect(count).toBe(1)
        expect(data[row * g.width + col]).toBe(Math.fround(z))
      }),
    )
  })

  const aggregates = {
    max: (zs) => Math.max(...zs),
    min: (zs) => Math.min(...zs),
    mean: (zs) => zs.reduce((a, b) => a + b, 0) / zs.length,
    median: (zs) => [...zs].sort((a, b) => a - b)[zs.length >> 1], // the upper median
  }
  for (const [aggregate, ref] of Object.entries(aggregates)) {
    it(`takes the ${aggregate} of each cell's points`, () => {
      fc.assert(
        fc.property(
          grid,
          fc.array(fc.tuple(num(0, 0.999), num(0, 0.999), num(-50, 500)), { minLength: 1, maxLength: 80 }),
          (g, raw) => {
            // Points spread over the window, by their fraction of it.
            const pts = raw.map(([fx, fy, z]) => ({
              x: g.originX + fx * g.width * g.gsd,
              y: g.originY - fy * g.height * g.gsd,
              z,
            }))
            const buckets = new Map()
            for (const p of pts) {
              const c = Math.floor((p.x - g.originX) / g.gsd),
                r = Math.floor((g.originY - p.y) / g.gsd)
              if (c < 0 || r < 0 || c >= g.width || r >= g.height) continue
              const k = r * g.width + c
              buckets.set(k, [...(buckets.get(k) ?? []), p.z])
            }
            const { data, count } = rasterizeWindow(pts, g, { aggregate, fillRadius: 0 })
            expect(count).toBe(buckets.size)
            for (let k = 0; k < g.width * g.height; k++) {
              const zs = buckets.get(k)
              if (!zs) expect(data[k]).toBeNaN()
              else expect(data[k]).toBeCloseTo(Math.fround(ref(zs)), 3)
            }
          },
        ),
      )
    })
  }
})

// A grid with some cells measured (value) and the rest nodata (NaN).
const sparseGrid = fc
  .record({ width: fc.integer({ min: 1, max: 14 }), height: fc.integer({ min: 1, max: 14 }) })
  .chain(({ width, height }) =>
    fc.record({
      width: fc.constant(width),
      height: fc.constant(height),
      cells: fc.array(fc.option(num(-100, 100), { freq: 3 }), { minLength: width * height, maxLength: width * height }),
    }),
  )
const toData = (cells) => Float32Array.from(cells, (v) => (v === null ? NaN : v))

describe('fillNodata', () => {
  for (const method of ['idw', 'nearest']) {
    it(`fills each hole from the measured cells within the radius (${method})`, () => {
      fc.assert(
        fc.property(sparseGrid, fc.integer({ min: 0, max: 4 }), ({ width, height, cells }, radius) => {
          const data = toData(cells)
          const measured = Uint8Array.from(data, (v) => (Number.isNaN(v) ? 0 : 1))
          const before = Float32Array.from(data)
          const filled = fillNodata(data, measured, width, height, radius, method)
          let expectFilled = 0
          for (let r = 0; r < height; r++)
            for (let c = 0; c < width; c++) {
              const k = r * width + c
              if (measured[k]) {
                expect(data[k]).toBe(before[k]) // measured cells never change
                continue
              }
              let ws = 0,
                vs = 0,
                best = Infinity,
                bestV = NaN
              // Scan order rows then columns: the first of equally near cells wins.
              for (let rr = 0; rr < height; rr++)
                for (let cc = 0; cc < width; cc++) {
                  const d2 = (rr - r) ** 2 + (cc - c) ** 2
                  if (!measured[rr * width + cc] || d2 > radius * radius) continue
                  ws += 1 / d2
                  vs += before[rr * width + cc] / d2
                  if (d2 < best) {
                    best = d2
                    bestV = before[rr * width + cc]
                  }
                }
              if (!ws) {
                expect(data[k]).toBeNaN()
                continue
              }
              expectFilled++
              expect(data[k]).toBeCloseTo(Math.fround(method === 'idw' ? vs / ws : bestV), 4)
            }
          expect(filled).toBe(expectFilled)
        }),
      )
    })
  }
})

describe('fillEnclosedGaps', () => {
  // Nodata cells reachable from the border through nodata (4-neighbours): the outside.
  function outside(data, width, height) {
    const out = new Uint8Array(width * height)
    const stack = []
    for (let r = 0; r < height; r++)
      for (let c = 0; c < width; c++)
        if ((r === 0 || c === 0 || r === height - 1 || c === width - 1) && Number.isNaN(data[r * width + c])) {
          out[r * width + c] = 1
          stack.push([r, c])
        }
    while (stack.length) {
      const [r, c] = stack.pop()
      for (const [dr, dc] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const rr = r + dr,
          cc = c + dc
        if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue
        const k = rr * width + cc
        if (!out[k] && Number.isNaN(data[k])) {
          out[k] = 1
          stack.push([rr, cc])
        }
      }
    }
    return out
  }

  it('fills exactly the enclosed nodata, within the range of the measured heights', () => {
    fc.assert(
      fc.property(sparseGrid, ({ width, height, cells }) => {
        const data = toData(cells)
        const before = Float32Array.from(data)
        const out = outside(before, width, height)
        const measured = [...before].filter((v) => !Number.isNaN(v))
        const lo = Math.min(...measured),
          hi = Math.max(...measured)
        const filled = fillEnclosedGaps(data, width, height)
        let enclosed = 0
        for (let k = 0; k < width * height; k++) {
          if (!Number.isNaN(before[k])) expect(data[k]).toBe(before[k])
          else if (out[k]) expect(data[k]).toBeNaN()
          else {
            enclosed++
            // Pull–push averages measured heights: never outside their range.
            expect(data[k]).toBeGreaterThanOrEqual(lo - 1e-3)
            expect(data[k]).toBeLessThanOrEqual(hi + 1e-3)
          }
        }
        expect(filled).toBe(measured.length ? enclosed : 0)
      }),
      { numRuns: 300 },
    )
  })

  it('fills a hole in a level surface at that level', () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 30 }), fc.integer({ min: 3, max: 30 }), num(-100, 3000), (w, h, z) => {
        const data = new Float32Array(w * h).fill(z)
        for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) data[r * w + c] = NaN
        expect(fillEnclosedGaps(data, w, h)).toBe((w - 2) * (h - 2))
        for (const v of data) expect(v).toBeCloseTo(Math.fround(z), 3)
      }),
    )
  })
})
