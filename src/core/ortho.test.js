import { describe, it, expect } from 'vitest'
import { sampleOrtho, orthorectify } from './ortho.js'
import { rasterizeDem } from './dem.js'
import { makeFrame } from './projection.js'

// A nadir camera at (cx,cy,H) looking straight down −Z over a flat plane z=0.
// For a horizontal plane every ground point is at camera-depth H, so the depth
// plane is a constant H — a valid synthetic z-buffer. Paints one solid colour.
function nadirMap({ cx, cy, H = 10, fx = 100, size = 100, color = [255, 0, 0], uuid = 'a' }) {
  const R = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
  const t = [-cx, cy, H] // t = -R·C
  const K = { fx, fy: fx, cx: size / 2, cy: size / 2 }
  const depth = new Float32Array(size * size).fill(H)
  const cost = new Float32Array(size * size) // all 0
  const rgb = new Uint8Array(size * size * 3)
  for (let i = 0; i < size * size; i++) { rgb[i * 3] = color[0]; rgb[i * 3 + 1] = color[1]; rgb[i * 3 + 2] = color[2] }
  return { uuid, width: size, height: size, K, R, t, depth, cost, rgb }
}

const identity = makeFrame({ origin: [0, 0, 0], east: [1, 0, 0], north: [0, 1, 0], up: [0, 0, 1] })

describe('sampleOrtho', () => {
  it('samples the colour of the one view that sees a ground point', () => {
    const m = nadirMap({ cx: 5, cy: 5, color: [10, 200, 30] })
    const rgb = sampleOrtho([5, 5, 0], [m], {})
    expect(rgb).toEqual([10, 200, 30])
  })

  it('rejects an occluded point (stored depth nearer than the cell)', () => {
    const m = nadirMap({ cx: 5, cy: 5, H: 10 })
    // Force the pixel the point projects to (image centre) to read a near depth.
    m.depth[50 * m.width + 50] = 3 // occluder at depth 3 ≪ 10
    expect(sampleOrtho([5, 5, 0], [m], { depthTolRel: 0.02 })).toBeNull()
  })

  it('best-view blend prefers the lower-cost source', () => {
    const red = nadirMap({ cx: 5, cy: 5, color: [255, 0, 0], uuid: 'red' })
    const blue = nadirMap({ cx: 5, cy: 5, color: [0, 0, 255], uuid: 'blue' })
    // Make blue higher-cost at the sampled pixel → red should win.
    blue.cost[50 * blue.width + 50] = 0.9
    red.cost[50 * red.width + 50] = 0.1
    expect(sampleOrtho([5, 5, 0], [blue, red], { blend: 'best' })).toEqual([255, 0, 0])
  })
})

describe('orthorectify', () => {
  it('colours every covered DEM cell from a single nadir view', () => {
    const m = nadirMap({ cx: 5, cy: 5, color: [40, 90, 160] })
    // Flat DEM over [2,8]² (projects to pixels 20..80, safely in-bounds).
    const pts = []
    for (let x = 2; x <= 8; x += 0.5) for (let y = 2; y <= 8; y += 0.5) pts.push({ x, y, z: 0 })
    const dem = rasterizeDem(pts, { gsd: 0.5, fillRadius: 0 })
    const ortho = orthorectify(dem, [m], identity.toSfm, {})
    expect(ortho.width).toBe(dem.width)
    expect(ortho.covered).toBeGreaterThan(0)
    // The first covered cell carries the source colour, alpha 255.
    let found = false
    for (let i = 0; i < dem.width * dem.height; i++) {
      if (ortho.rgba[i * 4 + 3] === 255) {
        expect([ortho.rgba[i * 4], ortho.rgba[i * 4 + 1], ortho.rgba[i * 4 + 2]]).toEqual([40, 90, 160])
        found = true; break
      }
    }
    expect(found).toBe(true)
  })

  it('leaves cells with no visible view transparent', () => {
    // Camera looks at a different area than the DEM → nothing projects in-bounds.
    const m = nadirMap({ cx: 500, cy: 500 })
    const pts = []
    for (let x = 2; x <= 6; x += 0.5) for (let y = 2; y <= 6; y += 0.5) pts.push({ x, y, z: 0 })
    const dem = rasterizeDem(pts, { gsd: 0.5, fillRadius: 0 })
    const ortho = orthorectify(dem, [m], identity.toSfm, {})
    expect(ortho.covered).toBe(0)
  })
})
