import { describe, it, expect } from 'vitest'
import { unprojectPixel, pixelUnprojector, pixelProjector, project } from './denseGeometry.js'

describe('pixelUnprojector', () => {
  it('writes the bits unprojectPixel returns, into the object it is given', () => {
    let s = 7
    const r = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32
    for (let k = 0; k < 20; k++) {
      const a = r() * 6,
        b = r() * 6
      const ca = Math.cos(a),
        sa = Math.sin(a),
        cb = Math.cos(b),
        sb = Math.sin(b)
      const m = {
        K: { fx: 800 + r() * 3000, fy: 800 + r() * 3000, cx: r() * 3000, cy: r() * 2000 },
        R: [
          [ca * cb, -sa, ca * sb],
          [sa * cb, ca, sa * sb],
          [-sb, 0, cb],
        ],
        t: [r() * 200 - 100, r() * 200 - 100, r() * 50],
      }
      const unproject = pixelUnprojector(m),
        out = { x: 0, y: 0, z: 0 }
      for (let i = 0; i < 200; i++) {
        const u = r() * 4000,
          v = r() * 3000,
          d = 0.1 + r() * 500
        const want = unprojectPixel(m, u, v, d)
        expect(unproject(u, v, d, out)).toBe(out)
        expect([Object.is(out.x, want.x), Object.is(out.y, want.y), Object.is(out.z, want.z)]).toEqual([
          true,
          true,
          true,
        ])
      }
    }
  })
})
