import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import {
  fundamentalFromCams, epipolarLine, clipLineToRect,
  gcpGuideForImage, gcpGuidesForImage, gcpEstimateForImage,
} from './gcpGuides.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  const bytes = await readFile(fileURLToPath(wasmUrl))
  await initRecon({ module_or_path: bytes })
})

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }

// Rotation about world Y (row-major, websfm convention).
function rotY(deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a)
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
}

// Camera from a world centre + rotation: world→cam is x_cam = R·x + t, and the
// centre satisfies C = -Rᵀt, so t = -R·C.
function makeCam(C, R) {
  const t = [
    -(R[0][0] * C[0] + R[0][1] * C[1] + R[0][2] * C[2]),
    -(R[1][0] * C[0] + R[1][1] * C[1] + R[1][2] * C[2]),
    -(R[2][0] * C[0] + R[2][1] * C[1] + R[2][2] * C[2]),
  ]
  return { R, t, K }
}

function project(cam, X) {
  const { R, t, K: k } = cam
  const xc = R[0][0] * X.x + R[0][1] * X.y + R[0][2] * X.z + t[0]
  const yc = R[1][0] * X.x + R[1][1] * X.y + R[1][2] * X.z + t[1]
  const zc = R[2][0] * X.x + R[2][1] * X.y + R[2][2] * X.z + t[2]
  return { px: k.fx * (xc / zc) + k.cx, py: k.fy * (yc / zc) + k.cy }
}

// Three cameras with *rotation*, not just translation — an identity-R rig hides
// the transpose/convention errors this is meant to catch.
const camA = makeCam([0, 0, 0], rotY(0))
const camB = makeCam([1, 0, 0], rotY(-6))
const camC = makeCam([0.4, 0.9, -0.2], rotY(3))
const X = { x: 0.2, y: -0.1, z: 5 }

describe('gcpEstimateForImage', () => {
  const cams = new Map([['imgA', camA], ['imgB', camB], ['imgC', camC]])
  const marksAt = (target, offset) => [
    { imageId: 'imgA', ...project(camA, X) },
    { imageId: 'imgB', ...project(camB, X) },
    // The target image's own mark, deliberately pulled off the true position.
    { imageId: target, px: project(camC, X).px + offset, py: project(camC, X).py },
  ]

  it('includes the target image\'s own mark, unlike a guide', async () => {
    // 2px off — inside the robust cut's absolute floor, so the mark is kept.
    const obs = marksAt('imgC', 2)
    const guide = await gcpGuideForImage(obs, 'imgC', camC, cams)
    const est = await gcpEstimateForImage(obs, camC, cams)
    // The guide ignores imgC's mark (that independence is the diagnostic); the
    // estimate is fitted with it, so it must be pulled toward the offset.
    const truth = project(camC, X)
    expect(guide.kind).toBe('point')
    expect(Math.abs(guide.u - truth.px)).toBeLessThan(1)
    expect(est.u).toBeGreaterThan(guide.u)
    expect(est.viewCount).toBe(3)
  })

  it('does not move when the robust fit rejects the new mark', async () => {
    // 60px off against two mutually-consistent marks ⇒ rejected, so the estimate
    // sits exactly where the guide predicted. This is the "did not move the
    // estimate" case the mark log reports: a stuck-looking number that actually
    // means "your mark disagreed and was left out", NOT a broken refinement.
    const obs = marksAt('imgC', 60)
    const guide = await gcpGuideForImage(obs, 'imgC', camC, cams)
    const est = await gcpEstimateForImage(obs, camC, cams)
    expect(Math.hypot(est.u - guide.u, est.v - guide.v)).toBeLessThan(1e-9)
  })

  it('returns null below 2 registered marks', async () => {
    const obs = [{ imageId: 'imgA', ...project(camA, X) }]
    expect(await gcpEstimateForImage(obs, camC, cams)).toBeNull()
  })

  it('returns null without a target camera', async () => {
    expect(await gcpEstimateForImage(marksAt('imgC', 0), null, cams)).toBeNull()
  })
})

describe('fundamentalFromCams / epipolarLine', () => {
  it('puts the true correspondence on the epipolar line (xBᵀ·F·xA = 0)', () => {
    const F = fundamentalFromCams(camA, camB)
    const a = project(camA, X)
    const b = project(camB, X)
    const line = epipolarLine(F, a.px, a.py)
    // Normalised line ⇒ |a·u + b·v + c| is the point-line distance in pixels.
    const dist = Math.abs(line[0] * b.px + line[1] * b.py + line[2])
    expect(dist).toBeLessThan(1e-6)
  })

  it('holds for several points and both orderings of the pair', () => {
    for (const P of [{ x: -1.5, y: 0.8, z: 3 }, { x: 2, y: -1, z: 8 }, { x: 0, y: 0, z: 4.2 }]) {
      const ab = epipolarLine(fundamentalFromCams(camA, camB), project(camA, P).px, project(camA, P).py)
      const b = project(camB, P)
      expect(Math.abs(ab[0] * b.px + ab[1] * b.py + ab[2])).toBeLessThan(1e-6)

      const ba = epipolarLine(fundamentalFromCams(camB, camA), b.px, b.py)
      const a = project(camA, P)
      expect(Math.abs(ba[0] * a.px + ba[1] * a.py + ba[2])).toBeLessThan(1e-6)
    }
  })

  it('rejects a zero-baseline (pure-rotation) pair', () => {
    const rotOnly = makeCam([0, 0, 0], rotY(10))
    expect(fundamentalFromCams(camA, rotOnly)).toBeNull()
  })

  it('does not put an unrelated pixel on the line', () => {
    const F = fundamentalFromCams(camA, camB)
    const line = epipolarLine(F, project(camA, X).px, project(camA, X).py)
    const b = project(camB, X)
    expect(Math.abs(line[0] * b.px + line[1] * (b.py + 40) + line[2])).toBeGreaterThan(1)
  })
})

describe('clipLineToRect', () => {
  it('clips a horizontal line to the image width', () => {
    const seg = clipLineToRect([0, 1, -200], 1000, 800) // v = 200
    expect(seg).toHaveLength(2)
    const xs = seg.map((p) => p.x).sort((m, n) => m - n)
    expect(xs[0]).toBeCloseTo(0)
    expect(xs[1]).toBeCloseTo(1000)
    for (const p of seg) expect(p.y).toBeCloseTo(200)
  })

  it('clips a diagonal to two border crossings inside the rect', () => {
    const n = Math.SQRT1_2
    const seg = clipLineToRect([n, -n, 0], 1000, 800) // u = v
    expect(seg).toHaveLength(2)
    for (const p of seg) {
      expect(p.x).toBeCloseTo(p.y)
      expect(p.x).toBeGreaterThanOrEqual(-1e-6)
      expect(p.x).toBeLessThanOrEqual(800 + 1e-6)
    }
  })

  it('returns null for a line that misses the image', () => {
    expect(clipLineToRect([0, 1, 5000], 1000, 800)).toBeNull() // v = -5000
    expect(clipLineToRect(null, 1000, 800)).toBeNull()
  })
})

describe('gcpGuideForImage', () => {
  const cams = new Map([['imgA', camA], ['imgB', camB], ['imgC', camC]])

  it('predicts an exact point from two other observations', async () => {
    const obs = [
      { imageId: 'imgA', ...project(camA, X) },
      { imageId: 'imgB', ...project(camB, X) },
    ]
    const guide = await gcpGuideForImage(obs, 'imgC', camC, cams)
    expect(guide.kind).toBe('point')
    expect(guide.viewCount).toBe(2)
    const truth = project(camC, X)
    expect(guide.u).toBeCloseTo(truth.px, 2)
    expect(guide.v).toBeCloseTo(truth.py, 2)
  })

  it('returns an epipolar line through the true pixel from a single observation', async () => {
    const obs = [{ imageId: 'imgA', ...project(camA, X) }]
    const guide = await gcpGuideForImage(obs, 'imgB', camB, cams)
    expect(guide.kind).toBe('line')
    expect(guide.viewCount).toBe(1)
    const truth = project(camB, X)
    const dist = Math.abs(guide.line[0] * truth.px + guide.line[1] * truth.py + guide.line[2])
    expect(dist).toBeLessThan(1e-6)
  })

  it('ignores the target image\'s own observation (the guide stays independent)', async () => {
    const obs = [
      { imageId: 'imgA', ...project(camA, X) },
      { imageId: 'imgB', px: 12, py: 34 }, // deliberately wrong mark on the target
    ]
    const guide = await gcpGuideForImage(obs, 'imgB', camB, cams)
    // Only imgA remains → a line, unaffected by the bogus imgB mark.
    expect(guide.kind).toBe('line')
    expect(guide.viewCount).toBe(1)
    const truth = project(camB, X)
    expect(Math.abs(guide.line[0] * truth.px + guide.line[1] * truth.py + guide.line[2])).toBeLessThan(1e-6)
  })

  it('ignores observations on unregistered images', async () => {
    const obs = [
      { imageId: 'imgA', ...project(camA, X) },
      { imageId: 'imgUnregistered', px: 100, py: 100 },
    ]
    const guide = await gcpGuideForImage(obs, 'imgC', camC, cams)
    expect(guide.kind).toBe('line') // one usable view, not two
  })

  it('returns null with no usable observations or no target pose', async () => {
    expect(await gcpGuideForImage([], 'imgC', camC, cams)).toBeNull()
    expect(await gcpGuideForImage([{ imageId: 'imgA', ...project(camA, X) }], 'imgC', null, cams)).toBeNull()
  })

  it('falls back to a line when the point triangulates behind the target camera', async () => {
    // A point behind camC: reprojecting it would give a meaningless pixel.
    const behind = { x: 0.4, y: 0.9, z: -3 }
    const obs = [
      { imageId: 'imgA', ...project(camA, behind) },
      { imageId: 'imgB', ...project(camB, behind) },
    ]
    const guide = await gcpGuideForImage(obs, 'imgC', camC, cams)
    expect(guide?.kind).toBe('line')
  })
})

describe('gcpGuidesForImage', () => {
  const sparseCameras = new Map([['uuidA', camA], ['uuidB', camB], ['uuidC', camC]])
  const imagesById = new Map([
    ['imgA', { uuid: 'uuidA' }], ['imgB', { uuid: 'uuidB' }], ['imgC', { uuid: 'uuidC' }],
  ])
  const twoViews = [
    { imageId: 'imgA', ...project(camA, X) },
    { imageId: 'imgB', ...project(camB, X) },
  ]

  it('guides unmarked GCPs and skips marked/disabled ones', async () => {
    const gcps = [
      { id: 'g1', name: 'G1', enabled: true, observations: twoViews },
      // Already marked on the target → no guide needed.
      { id: 'g2', name: 'G2', enabled: true, observations: [...twoViews, { imageId: 'imgC', ...project(camC, X) }] },
      { id: 'g3', name: 'G3', enabled: false, observations: twoViews },
      { id: 'g4', name: 'G4', enabled: true, observations: [] },
    ]
    const guides = await gcpGuidesForImage(gcps, 'imgC', sparseCameras, imagesById)
    expect(guides.map((g) => g.gcpId)).toEqual(['g1'])
    expect(guides[0]).toMatchObject({ name: 'G1', kind: 'point' })
  })

  it('returns nothing for an unregistered target image', async () => {
    const gcps = [{ id: 'g1', name: 'G1', enabled: true, observations: twoViews }]
    const imgs = new Map([...imagesById, ['imgX', { uuid: 'uuidX' }]])
    expect(await gcpGuidesForImage(gcps, 'imgX', sparseCameras, imgs)).toEqual([])
  })
})
