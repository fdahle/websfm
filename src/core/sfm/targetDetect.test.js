import { describe, it, expect } from 'vitest'
import { findCheckerCorner, refineCorner, gaussianBlur } from './targetDetect.js'

// A checker mat (2 × 2 quadrants, `size` px a side) centred at (cx, cy), turned by `angle`,
// anti-aliased by 4 × 4 supersampling, on grass-grey with Gaussian noise.
function renderTarget({ w = 160, h = 160, cx, cy, size = 40, angle = 0, noise = 4, seed = 1 }) {
  let s = seed
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const data = new Float32Array(w * h)
  const c = Math.cos(angle),
    sn = Math.sin(angle)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const px = x - 0.5 + (i + 0.5) / 4 - cx,
            py = y - 0.5 + (j + 0.5) / 4 - cy
          const u = c * px + sn * py,
            t = -sn * px + c * py
          if (Math.abs(u) > size / 2 || Math.abs(t) > size / 2) v += 110
          else v += u * t > 0 ? 235 : 25
        }
      data[y * w + x] = v / 16 + noise * rand()
    }
  return { data, width: w, height: h }
}

describe('findCheckerCorner', () => {
  it('finds a turned, noisy target to a tenth of a pixel from a guess 20 px off', () => {
    for (const [cx, cy, angle] of [
      [80.3, 79.6, 0.2],
      [71.75, 88.4, 0.9],
      [90.1, 70.2, -0.5],
    ]) {
      const img = gaussianBlur(renderTarget({ cx, cy, angle }), 1)
      const r = findCheckerCorner(img, { x: cx + 14, y: cy - 14 }, { radius: 30, quadRadius: 12 })
      expect(r, `${cx},${cy}`).not.toBeNull()
      expect(Math.hypot(r.x - cx, r.y - cy)).toBeLessThan(0.1)
      expect(r.score).toBeGreaterThan(0.5)
    }
  })

  it('finds nothing in grass and nothing at a plain edge', () => {
    const noise = renderTarget({ cx: -1000, cy: -1000, noise: 20 })
    expect(findCheckerCorner(noise, { x: 80, y: 80 }, { radius: 30, quadRadius: 12 })).toBeNull()
    const edge = { width: 120, height: 120, data: new Float32Array(120 * 120).map((_, i) => (i % 120 < 60 ? 30 : 220)) }
    expect(findCheckerCorner(edge, { x: 60, y: 60 }, { radius: 30, quadRadius: 12 })).toBeNull()
  })
})

describe('refineCorner', () => {
  it('converges from a few pixels off', () => {
    const img = gaussianBlur(renderTarget({ cx: 80.8, cy: 80.3, angle: 0.4, noise: 0 }), 1.2)
    const p = refineCorner(img, 78, 82)
    expect(Math.hypot(p.x - 80.8, p.y - 80.3)).toBeLessThan(0.05)
  })
})
