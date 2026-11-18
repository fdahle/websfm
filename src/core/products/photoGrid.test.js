import { describe, expect, it } from 'vitest'
import {
  alignedPhotoGrid,
  cloudHeightSurface,
  gridMesh,
  heightSurface,
  photoGridBuilder,
  photoGroundGrid,
} from './photoGrid.js'
import { makePinholeToMark } from '../sfm/displayFrame.js'
import { distortPixel } from '../sfm/distortion.js'

// A nadir camera at C looking straight down, image x east and image y south (world
// → camera rows: east, −north, −up).
function nadir(C, K = { fx: 1000, fy: 1000, cx: 499.5, cy: 399.5 }) {
  const R = [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ]
  return { R, t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])), K }
}
// The camera turned about its x axis by `deg` (towards north: the top of the photo
// looks farther out).
function tilted(C, deg, K) {
  const a = (-deg * Math.PI) / 180
  const Rx = [
    [1, 0, 0],
    [0, Math.cos(a), -Math.sin(a)],
    [0, Math.sin(a), Math.cos(a)],
  ]
  const base = nadir(C, K).R
  const R = Rx.map((r) => base[0].map((_, j) => r[0] * base[0][j] + r[1] * base[1][j] + r[2] * base[2][j]))
  return { R, t: R.map((r) => -(r[0] * C[0] + r[1] * C[1] + r[2] * C[2])), K: K ?? nadir(C).K }
}
// A world point into the camera's pinhole pixel.
function project(cam, X) {
  const p = cam.R.map((r, i) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + cam.t[i])
  return [cam.K.fx * (p[0] / p[2]) + cam.K.cx, cam.K.fy * (p[1] / p[2]) + cam.K.cy, p[2]]
}
const identity = (p) => [p[0], p[1], p[2]]
const edge = (u, v) => ({ x: u + 0.5, y: v + 0.5 })
const base = { width: 1000, height: 800, scanWidth: 1000, scanHeight: 800, toScan: edge, toMap: identity }
const nodes = (g) =>
  Array.from({ length: (g.cells + 1) ** 2 }, (_, k) => ({
    k,
    i: k % (g.cells + 1),
    j: Math.floor(k / (g.cells + 1)),
    x: g.dst[2 * k],
    y: g.dst[2 * k + 1],
  }))

describe('photoGroundGrid', () => {
  it('casts a nadir photo onto flat ground where the pinhole model puts each pixel', () => {
    const cam = nadir([100, 200, 50])
    const g = photoGroundGrid({ ...base, cam, heightAt: () => 0, cells: 4 })
    for (const { i, j, x, y } of nodes(g)) {
      const u = (i / 4) * 1000 - 0.5,
        v = (j / 4) * 800 - 0.5
      expect(x).toBeCloseTo(100 + ((u - 499.5) / 1000) * 50, 6)
      expect(y).toBeCloseTo(200 - ((v - 399.5) / 1000) * 50, 6)
    }
    // The photo position of the corner nodes is the frame's corner (edge convention).
    expect([g.src[0], g.src[1]]).toEqual([0, 0])
    const last = 2 * ((g.cells + 1) ** 2 - 1)
    expect([g.src[last], g.src[last + 1]]).toEqual([1, 1])
  })

  it('puts every node on the relief and on its own ray, for a hill under a tilted photo', () => {
    const hill = (x, y) => 10 + 25 * Math.exp(-((x - 100) ** 2 + (y - 230) ** 2) / 800)
    const cam = tilted([100, 200, 120], 20)
    const g = photoGroundGrid({ ...base, cam, heightAt: hill, cells: 8 })
    let landed = 0
    for (const { i, j, x, y } of nodes(g)) {
      if (Number.isNaN(x)) continue
      landed++
      const X = [x, y, hill(x, y)]
      const [u, v, depth] = project(cam, X)
      expect(depth).toBeGreaterThan(0)
      // Placed to within 10⁻⁴ of the flying height (1 cm here): a tenth of a pixel.
      expect(Math.abs(u - ((i / 8) * 1000 - 0.5))).toBeLessThan(0.1)
      expect(Math.abs(v - ((j / 8) * 800 - 0.5))).toBeLessThan(0.1)
    }
    expect(landed).toBe(81)
  })

  it('moves the photo centre with the relief, where a flat footprint would not', () => {
    const cam = tilted([0, 0, 100], 30)
    const flat = photoGroundGrid({ ...base, cam, heightAt: () => 0, cells: 2 })
    const raised = photoGroundGrid({
      ...base,
      cam,
      heightAt: (x, y) => (Math.hypot(x, y - 58) < 20 ? 30 : 0),
      cells: 2,
    })
    // The centre ray meets a 30 m block before the ground, nearer the camera.
    const centre = 2 * 4
    expect(raised.dst[centre + 1]).toBeLessThan(flat.dst[centre + 1] - 10)
    // The corners, off the block, stay where they were.
    expect(raised.dst[0]).toBeCloseTo(flat.dst[0], 6)
    expect(raised.dst[1]).toBeCloseTo(flat.dst[1], 6)
  })

  it('leaves out the nodes past the horizon of an oblique photo, and their cells', () => {
    const cam = tilted([0, 0, 100], 80)
    const g = photoGroundGrid({ ...base, cam, heightAt: () => 0, cells: 4 })
    const top = nodes(g).filter((n) => n.j === 0)
    const bottom = nodes(g).filter((n) => n.j === 4)
    expect(top.every((n) => Number.isNaN(n.x))).toBe(true)
    expect(bottom.every((n) => Number.isFinite(n.x))).toBe(true)
    const mesh = gridMesh(g)
    expect(mesh.length).toBeLessThan(2 * 16)
    expect(mesh.length).toBeGreaterThan(0)
    for (const t of mesh) for (const [x] of t.dst) expect(Number.isFinite(x)).toBe(true)
  })

  it('gives no grid for a camera under the surface', () => {
    const cam = nadir([0, 0, 50])
    expect(photoGroundGrid({ ...base, cam, heightAt: () => 60 })).toBeNull()
  })

  it('takes the photo position of each node through the lens, from the raw photo', () => {
    const K = { fx: 1000, fy: 1000, cx: 499.5, cy: 399.5 }
    const dist = { k1: -0.2, k2: 0.05, k3: 0, p1: 0, p2: 0 }
    const cam = nadir([0, 0, 50], K)
    const toScan = makePinholeToMark({ K, dist })
    const g = photoGroundGrid({ ...base, toScan, cam, heightAt: () => 0, cells: 2 })
    // Top-left node: pinhole (−½, −½), recorded by the barrel lens nearer the centre.
    const d = distortPixel(-0.5, -0.5, K, dist)
    expect(g.src[0]).toBeCloseTo((d.x + 0.5) / 1000, 12)
    expect(g.src[1]).toBeCloseTo((d.y + 0.5) / 800, 12)
    expect(g.src[0]).toBeGreaterThan(0)
    // The ground position is the pinhole ray's: the lens moves the pixel, not the ray.
    expect(g.dst[0]).toBeCloseTo(((-0.5 - 499.5) / 1000) * 50, 6)
  })

  it('places the grid through the map frame it is given', () => {
    const cam = nadir([0, 0, 50])
    // A map frame 1,000 east and twice the model's scale.
    const toMap = (p) => [2 * p[0] + 1000, 2 * p[1], 2 * p[2]]
    const g = photoGroundGrid({ ...base, cam, toMap, heightAt: () => 0, cells: 2 })
    const centre = 2 * 4
    expect(g.dst[centre]).toBeCloseTo(1000, 6)
  })
})

describe('alignedPhotoGrid', () => {
  const cam = nadir([0, 0, 50], { fx: 1000, fy: 1000, cx: 999.5, cy: 999.5 })
  it('lays a film scan’s grid over its fiducial frame, so the collar stays off the map', () => {
    // A 60 mm scan at 0.02 mm a pixel (3,000 px), y up in millimetres; the 50 mm
    // fiducial frame at 0.025 mm a pixel (2,000 px) centred on it.
    const fiducial = {
      A: [0.02, 0, -30, 0, -0.02, 30],
      frame: { width: 2000, height: 2000, pitchMm: 0.025, originX: -25, originY: 25, ySign: -1 },
    }
    const image = { meta: { width: 3000, height: 3000 } }
    const g = alignedPhotoGrid({ image, cam, frameModel: { fiducial }, toMap: identity, heightAt: () => 0, cells: 4 })
    // Pinhole (−½, −½) is 25.0125 mm left of and above the centre: scan pixel 249.375.
    expect(g.src[0] * 3000).toBeCloseTo(249.375 + 0.5, 9)
    expect(g.src[1] * 3000).toBeCloseTo(249.375 + 0.5, 9)
    for (const s of g.src) expect(s * 3000).toBeGreaterThan(249)
    for (const s of g.src) expect(s * 3000).toBeLessThan(2751)
    // The frame's corner ray: 1,000 px of a 1,000 px focal off the axis, 50 m down.
    expect(g.dst[0]).toBeCloseTo(-50, 6)
  })

  it('gives no grid for a photo the model did not align, or whose film frame the run lacks', () => {
    const image = { meta: { width: 2000, height: 2000 } }
    const args = { image, toMap: identity, heightAt: () => 0 }
    expect(alignedPhotoGrid({ ...args, cam: null })).toBeNull()
    expect(alignedPhotoGrid({ ...args, cam, frameModel: { filmMissing: true } })).toBeNull()
    expect(alignedPhotoGrid({ ...args, cam, image: { meta: {} } })).toBeNull()
    expect(alignedPhotoGrid({ ...args, cam })).not.toBeNull()
  })
})

describe('cloudHeightSurface', () => {
  it('takes the points into the map frame before it measures heights', () => {
    const pts = []
    for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) pts.push(x, y, 7)
    // A map frame that lifts everything by 100.
    const s = cloudHeightSurface(new Float64Array(pts), (p) => [p[0], p[1], p[2] + 100])
    expect(s.heightAt(25, 25)).toBeCloseTo(107, 9)
  })
})

describe('photoGridBuilder', () => {
  it('casts each aligned photo once, onto one surface of the tie points, and none for the rest', () => {
    const pos = []
    for (let x = -100; x <= 100; x += 2) for (let y = -100; y <= 100; y += 2) pos.push(x, y, 5)
    let mapped = 0
    const toMap = (p) => (mapped++, [p[0], p[1], p[2]])
    const cam = nadir([0, 0, 55], { fx: 1000, fy: 1000, cx: 999.5, cy: 999.5 })
    const gridFor = photoGridBuilder({ cameras: new Map([['u1', cam]]), pos: new Float64Array(pos), toMap, cells: 2 })
    const image = { id: 'a', uuid: 'u1', meta: { width: 2000, height: 2000 } }
    const g = gridFor(image)
    // 50 m above ground at 5: the frame's corner ray lands 50 m out.
    expect(g.dst[0]).toBeCloseTo(-50, 6)
    expect(gridFor(image)).toBe(g)
    const afterOne = mapped
    expect(gridFor({ id: 'b', uuid: 'u2', meta: { width: 2000, height: 2000 } })).toBeNull()
    expect(mapped).toBe(afterOne)
  })
})

describe('gridMesh', () => {
  it('cuts a grid whose nodes all landed into two triangles a cell, src and dst paired', () => {
    const cam = nadir([0, 0, 50])
    const g = photoGroundGrid({ ...base, cam, heightAt: () => 0, cells: 3 })
    const mesh = gridMesh(g)
    expect(mesh).toHaveLength(18)
    // On flat ground under a nadir camera the map is affine in the photo: x = −25 + 50u.
    for (const t of mesh) {
      t.src.forEach(([u], k) => expect(t.dst[k][0]).toBeCloseTo(-25 + 50 * u, 6))
    }
  })
})

describe('heightSurface', () => {
  // Points every metre over [0, 100]², on z(x, y).
  function lattice(z, extra = []) {
    const out = []
    for (let x = 0.5; x < 100; x++) for (let y = 0.5; y < 100; y++) out.push(x, y, z(x, y))
    return new Float64Array([...out, ...extra])
  }

  it('reproduces a plane inside the points', () => {
    const s = heightSurface(lattice((x, y) => 3 + 0.2 * x - 0.1 * y))
    for (const [x, y] of [
      [20, 30],
      [50, 50],
      [77, 12],
    ])
      expect(s.heightAt(x, y)).toBeCloseTo(3 + 0.2 * x - 0.1 * y, 1)
  })

  it('ignores a stray point: a cell takes the median of its points', () => {
    const s = heightSurface(lattice(() => 5, [50.2, 50.2, 400]))
    expect(s.heightAt(50.2, 50.2)).toBeCloseTo(5, 6)
  })

  it('fills a hole from the heights around it, and holds the edge value outside', () => {
    const pts = []
    for (let x = 0.5; x < 100; x++)
      for (let y = 0.5; y < 100; y++) if (x < 30 || x > 70) pts.push(x, y, x < 50 ? 0 : 10)
    const s = heightSurface(new Float64Array(pts))
    const mid = s.heightAt(50, 50)
    expect(mid).toBeGreaterThanOrEqual(0)
    expect(mid).toBeLessThanOrEqual(10)
    expect(s.heightAt(-500, 50)).toBeCloseTo(0, 6)
    expect(s.heightAt(900, 50)).toBeCloseTo(10, 6)
  })

  it('is null without enough points to make a surface', () => {
    expect(heightSurface(new Float64Array([0, 0, 1, 0, 0, 2]))).toBeNull()
    expect(heightSurface(new Float64Array([1, 1, 1, 1, 1, 2, 1, 1, 3]))).toBeNull()
  })
})

describe('gridMesh with a step', () => {
  it('keeps the frame’s corners and every step-th node, for a thumbnail', () => {
    const cam = nadir([0, 0, 50])
    const g = photoGroundGrid({ ...base, cam, heightAt: () => 0, cells: 12 })
    const coarse = gridMesh(g, { step: 3 })
    expect(coarse).toHaveLength(32)
    const corners = coarse.flatMap((t) => t.src).filter(([u, v]) => (u === 0 || u === 1) && (v === 0 || v === 1))
    expect(new Set(corners.map(String)).size).toBe(4)
    // A step that does not divide the grid still ends on its last node.
    const odd = gridMesh(g, { step: 5 })
    expect(odd).toHaveLength(2 * 3 * 3)
    expect(odd.some((t) => t.src.some(([u]) => u === 1))).toBe(true)
  })
})
