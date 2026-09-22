import { it, expect } from 'vitest'
import { pointView, relativePositions } from './pointView.ts'
import { rasterizeDem } from './dem.js'
it('retains centimetres at survey-coordinate magnitudes in the render buffer', () => {
  const pos = new Float64Array([7_000_000.01, 500_000.01, 100, 7_000_000.02, 500_000.02, 101])
  const { origin, relative } = relativePositions(pos)
  expect(relative[3]).toBeCloseTo(0.01, 7)
  expect(origin[0] + relative[3]).toBeCloseTo(pos[3], 7)
  expect(pos[0]).toBe(7_000_000.01)
})
it.each(['min', 'max', 'mean', 'median'])('rasterizes packed points identically for %s', aggregate => {
  const points = [{ x: 0, y: 0, z: 2 }, { x: 1, y: 1, z: 3 }, { x: 1, y: 1, z: 5 }]
  const pos = Float64Array.from(points.flatMap(p => [p.x, p.y, p.z]))
  expect(rasterizeDem(pointView({ pos }), { aggregate })).toEqual(rasterizeDem(points, { aggregate }))
})
it('rejects oversized raster allocations before allocating', () => {
  expect(() => rasterizeDem([{ x: 0, y: 0, z: 1 }, { x: 10000, y: 10000, z: 1 }], { gsd: 1, maxGrid: 20000 }))
    .toThrow('working-memory limit')
})
