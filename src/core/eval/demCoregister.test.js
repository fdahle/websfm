import { describe, expect, it } from 'vitest'
import { coregisterNuthKaab } from './demCoregister.js'

// Ridged terrain in metres; the DEM is the same surface displaced by `shift` with
// noise, the reference the surface itself.
const h = (x, y) => 400 * Math.sin(x / 700) * Math.cos(y / 900) + 250 * Math.sin((x + 2 * y) / 450)
function sample(shift, { bias = 0, noise = 0, seed = 3 } = {}) {
  let s = seed
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5
  const points = []
  for (let y = 0; y < 6000; y += 40)
    for (let x = 0; x < 6000; x += 40) points.push({ x, y, z: h(x - shift[0], y - shift[1]) + bias + noise * rnd() })
  return points
}

describe('coregisterNuthKaab', () => {
  it('recovers a horizontal shift and a vertical bias', () => {
    const r = coregisterNuthKaab(sample([3, 11], { bias: -2, noise: 4 }), (x, y) => h(x, y), { cell: 20 })
    expect(r.converged).toBe(true)
    expect(r.shift[0]).toBeCloseTo(3, 0)
    expect(r.shift[1]).toBeCloseTo(11, 0)
    expect(r.bias).toBeCloseTo(-2, 0)
    expect(r.nmadAfter).toBeLessThan(r.nmadBefore / 3)
  })
  it('reports no shift for an aligned DEM', () => {
    const r = coregisterNuthKaab(sample([0, 0], { noise: 2 }), (x, y) => h(x, y), { cell: 20 })
    expect(Math.hypot(...r.shift)).toBeLessThan(0.5)
  })
  it('needs points on slopes of every aspect', () => {
    expect(coregisterNuthKaab([{ x: 0, y: 0, z: 1 }], () => 0, { cell: 20 })).toBeNull()
  })
})
