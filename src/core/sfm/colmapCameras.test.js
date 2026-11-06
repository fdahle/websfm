import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { distortPixel, undistortPixel } from './distortion.js'

// WebSfM's lens models against COLMAP's, on rays COLMAP projected itself
// (tests/fixtures/colmap/cameras.json, scripts/fixtures/make-colmap-cameras.py, pycolmap).
// Projection through a given lens has one right answer, so these are checks against the
// specification, not against what the code happened to return: OpenCV's Brown–Conrady
// (OPENCV, RADIAL, SIMPLE_RADIAL), its rational model (FULL_OPENCV, WebSfM's
// "rational") and Kannala–Brandt (OPENCV_FISHEYE).
const fixture = JSON.parse(readFileSync(new URL('../../../tests/fixtures/colmap/cameras.json', import.meta.url)))

// A COLMAP camera as WebSfM's intrinsics K and its distortion bag (distortion.js).
function fromColmap({ model, paramNames, params }) {
  const p = Object.fromEntries(paramNames.map((n, i) => [n, params[i]]))
  const K = p.f != null ? { fx: p.f, fy: p.f, cx: p.cx, cy: p.cy } : { fx: p.fx, fy: p.fy, cx: p.cx, cy: p.cy }
  const zero = { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }
  const d = {
    OPENCV: { ...zero, k1: p.k1, k2: p.k2, p1: p.p1, p2: p.p2 },
    FULL_OPENCV: { ...zero, ...pick(p, ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2']) },
    OPENCV_FISHEYE: { fisheye: true, ...pick(p, ['k1', 'k2', 'k3', 'k4']) },
    RADIAL: { ...zero, k1: p.k1, k2: p.k2 },
    SIMPLE_RADIAL: { ...zero, k1: p.k },
  }[model]
  return { K, d }
}
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))

describe('lens models against COLMAP', () => {
  it('covers every model WebSfM has an equivalent of', () => {
    expect(new Set(fixture.cases.map((c) => c.model))).toEqual(
      new Set(['OPENCV', 'FULL_OPENCV', 'OPENCV_FISHEYE', 'RADIAL', 'SIMPLE_RADIAL']),
    )
  })

  for (const c of fixture.cases) {
    const { K, d } = fromColmap(c)
    const ideal = c.rays.map(([x, y, z]) => ({ x: K.fx * (x / z) + K.cx, y: K.fy * (y / z) + K.cy }))

    it(`${c.model} ${c.params.slice(4).join(' ')}: projects a ray to COLMAP's pixel`, () => {
      ideal.forEach((q, i) => {
        const px = distortPixel(q.x, q.y, K, d)
        expect(Math.abs(px.x - c.pixels[i][0])).toBeLessThan(1e-6)
        expect(Math.abs(px.y - c.pixels[i][1])).toBeLessThan(1e-6)
      })
    })

    it(`${c.model} ${c.params.slice(4).join(' ')}: recovers the ray from COLMAP's pixel`, () => {
      c.pixels.forEach(([u, v], i) => {
        const back = undistortPixel(u, v, K, d)
        // COLMAP's own inverse (cam_from_img), and the ray itself.
        const [nx, ny] = c.normalized[i]
        expect(Math.abs((back.x - K.cx) / K.fx - nx)).toBeLessThan(1e-9)
        expect(Math.abs((back.y - K.cy) / K.fy - ny)).toBeLessThan(1e-9)
        expect(Math.abs(back.x - ideal[i].x)).toBeLessThan(1e-6)
        expect(Math.abs(back.y - ideal[i].y)).toBeLessThan(1e-6)
      })
    })
  }
})
