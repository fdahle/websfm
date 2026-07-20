import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { triangulateGcp, triangulateAllGcps, refineGcpPoint } from './gcpTriangulation.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  const bytes = await readFile(fileURLToPath(wasmUrl))
  await initRecon({ module_or_path: bytes })
})

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }

// Two cameras: A at the origin, B shifted +1 along world-X (t = -baseline).
const camA = { R: I3, t: [0, 0, 0], K }
const camB = { R: I3, t: [-1, 0, 0], K }

// Two more for the N-view tests, placed so that **camA↔camB is unambiguously the
// widest baseline** and therefore the DLT seed pair. Centres (C = −Rᵀt, R = I so
// C = −t): A [0,0,0], B [1,0,0], C [0.3,0.4,0], D [0.6,−0.3,0] — every other
// pairing is ≤0.81 apart against A↔B's 1.0, and C/D sit off the A–B axis so they
// still constrain the point. This is load-bearing: a test that puts noise on a
// seed-pair mark and expects the other views to outvote it is only testing that
// if the seed pair is the one it thinks. (An earlier version of these cameras had
// C at [0,1,0], making B↔C the widest at 1.41 — the "noisy" mark then never
// entered the seed at all and the test passed for the wrong reason.)
const camC = { R: I3, t: [-0.3, -0.4, 0], K }
const camD = { R: I3, t: [-0.6, 0.3, 0], K }

function project(cam, X) {
  const { R, t, K: k } = cam
  const xc = R[0][0] * X.x + R[0][1] * X.y + R[0][2] * X.z + t[0]
  const yc = R[1][0] * X.x + R[1][1] * X.y + R[1][2] * X.z + t[1]
  const zc = R[2][0] * X.x + R[2][1] * X.y + R[2][2] * X.z + t[2]
  return { px: k.fx * (xc / zc) + k.cx, py: k.fy * (yc / zc) + k.cy }
}

describe('triangulateGcp', () => {
  it('recovers a known 3D point from two registered-image observations', async () => {
    const X = { x: 0.2, y: -0.1, z: 5 }
    const obsA = project(camA, X)
    const obsB = project(camB, X)
    const cams = new Map([['imgA', camA], ['imgB', camB]])
    const observations = [
      { imageId: 'imgA', px: obsA.px, py: obsA.py },
      { imageId: 'imgB', px: obsB.px, py: obsB.py },
    ]

    const tri = await triangulateGcp(observations, cams)
    expect(tri).not.toBeNull()
    expect(tri.x).toBeCloseTo(X.x, 3)
    expect(tri.y).toBeCloseTo(X.y, 3)
    expect(tri.z).toBeCloseTo(X.z, 3)
    expect(tri.viewCount).toBe(2)
    for (const { reprojPx } of tri.perViewReprojPx) expect(reprojPx).toBeCloseTo(0, 2)
  })

  it('returns null with fewer than 2 registered observations', async () => {
    const cams = new Map([['imgA', camA]])
    const observations = [{ imageId: 'imgA', px: 500, py: 400 }, { imageId: 'imgUnregistered', px: 500, py: 400 }]
    expect(await triangulateGcp(observations, cams)).toBeNull()
  })

  it('reports nonzero reprojection residual for an inconsistent third observation', async () => {
    const X = { x: 0.2, y: -0.1, z: 5 }
    const obsA = project(camA, X)
    const obsB = project(camB, X)
    const camC = { R: I3, t: [0, -1, 0], K }
    const cams = new Map([['imgA', camA], ['imgB', camB], ['imgC', camC]])
    const observations = [
      { imageId: 'imgA', px: obsA.px, py: obsA.py },
      { imageId: 'imgB', px: obsB.px, py: obsB.py },
      { imageId: 'imgC', px: obsA.px + 50, py: obsA.py }, // deliberately wrong mark
    ]

    const tri = await triangulateGcp(observations, cams)
    const cEntry = tri.perViewReprojPx.find((o) => o.imageId === 'imgC')
    expect(cEntry.reprojPx).toBeGreaterThan(10)
  })
})

describe('refineGcpPoint', () => {
  const X = { x: 0.2, y: -0.1, z: 5 }
  const viewsFor = (cams) => cams.map((cam) => ({ ...project(cam, X), cam }))

  it('pulls a perturbed seed back onto the true point', () => {
    const views = viewsFor([camA, camB, camC])
    const out = refineGcpPoint(views, { x: X.x + 0.3, y: X.y - 0.2, z: X.z + 0.8 })
    expect(out.x).toBeCloseTo(X.x, 5)
    expect(out.y).toBeCloseTo(X.y, 5)
    expect(out.z).toBeCloseTo(X.z, 5)
  })

  it('is a no-op on an already-exact seed', () => {
    const views = viewsFor([camA, camB, camC])
    const out = refineGcpPoint(views, X)
    expect(out.x).toBeCloseTo(X.x, 6)
    expect(out.y).toBeCloseTo(X.y, 6)
    expect(out.z).toBeCloseTo(X.z, 6)
  })

  it('never returns worse than the seed for a degenerate single-view set', () => {
    const seed = { x: 1, y: 2, z: 3 }
    expect(refineGcpPoint(viewsFor([camA]), seed)).toEqual(seed)
  })

  it('never accepts a step that makes a view unprojectable', () => {
    // A view the point cannot project into drops out of the cost sum, so a step
    // that hides one would look like an improvement while being geometrically
    // worse. Whatever the iteration does, every view projectable at the seed must
    // still be projectable at the result.
    const cams = [camA, camB, camC, camD]
    const projectable = (p) => cams.map((c) => {
      const zc = c.R[2][0] * p.x + c.R[2][1] * p.y + c.R[2][2] * p.z + c.t[2]
      return Number.isFinite(zc) && Math.abs(zc) >= 1e-9
    })
    // Near-degenerate seeds: barely in front of the cameras, so a large GN step
    // can easily overshoot through a camera plane.
    for (const seed of [{ x: 0, y: 0, z: 1e-6 }, { x: 5, y: -5, z: 1e-4 }, { x: 0.2, y: -0.1, z: 0.001 }]) {
      const before = projectable(seed)
      const out = refineGcpPoint(viewsFor(cams), seed)
      const after = projectable(out)
      for (let i = 0; i < cams.length; i++) {
        if (before[i]) expect(after[i]).toBe(true)
      }
    }
  })
})

describe('triangulateGcp — N-view refinement', () => {
  const X = { x: 0.2, y: -0.1, z: 5 }
  const cams = new Map([['imgA', camA], ['imgB', camB], ['imgC', camC], ['imgD', camD]])

  // imgA is in the seed pair (camA↔camB is the widest baseline — see the camera
  // note above) and carries a few px of marking noise, which a pair-only fit has
  // no way to see. The clean C/D marks can outvote it only if they reach the fit.
  const noisySeedMark = () => {
    const oa = project(camA, X), ob = project(camB, X)
    const oc = project(camC, X), od = project(camD, X)
    return [
      { imageId: 'imgA', px: oa.px + 4, py: oa.py + 4 },
      { imageId: 'imgB', px: ob.px, py: ob.py },
      { imageId: 'imgC', px: oc.px, py: oc.py },
      { imageId: 'imgD', px: od.px, py: od.py },
    ]
  }
  const errFrom = (p) => Math.hypot(p.x - X.x, p.y - X.y, p.z - X.z)

  it('uses observations beyond the widest-baseline pair', async () => {
    const observations = noisySeedMark()
    const pairOnly = await triangulateGcp(observations.slice(0, 2), new Map([['imgA', camA], ['imgB', camB]]))
    const nView = await triangulateGcp(observations, cams)
    expect(errFrom(nView)).toBeLessThan(errFrom(pairOnly))
  })

  it('reports every view in perViewReprojPx and rejects none by default', async () => {
    const oa = project(camA, X), ob = project(camB, X), oc = project(camC, X)
    const observations = [
      { imageId: 'imgA', px: oa.px, py: oa.py },
      { imageId: 'imgB', px: ob.px, py: ob.py },
      { imageId: 'imgC', px: oc.px + 80, py: oc.py }, // misclick
    ]

    const tri = await triangulateGcp(observations, new Map([['imgA', camA], ['imgB', camB], ['imgC', camC]]))
    expect(tri.viewCount).toBe(3)
    expect(tri.perViewReprojPx).toHaveLength(3)
    expect(tri.rejectedImageIds).toEqual([])
  })
})

describe('triangulateGcp — robust rejection', () => {
  const X = { x: 0.2, y: -0.1, z: 5 }
  const cams = new Map([['imgA', camA], ['imgB', camB], ['imgC', camC], ['imgD', camD]])
  const clean = () => {
    const oa = project(camA, X), ob = project(camB, X), oc = project(camC, X), od = project(camD, X)
    return [
      { imageId: 'imgA', px: oa.px, py: oa.py },
      { imageId: 'imgB', px: ob.px, py: ob.py },
      { imageId: 'imgC', px: oc.px, py: oc.py },
      { imageId: 'imgD', px: od.px, py: od.py },
    ]
  }

  it('drops a misclicked mark and recovers the true point', async () => {
    const observations = clean()
    observations[2] = { imageId: 'imgC', px: observations[2].px + 90, py: observations[2].py - 60 }

    const loose = await triangulateGcp(observations, cams)
    const tri = await triangulateGcp(observations, cams, { robust: true })

    expect(tri.rejectedImageIds).toEqual(['imgC'])
    const err = (t) => Math.hypot(t.x - X.x, t.y - X.y, t.z - X.z)
    expect(err(tri)).toBeLessThan(err(loose))
    expect(tri.x).toBeCloseTo(X.x, 3)
    expect(tri.y).toBeCloseTo(X.y, 3)
    expect(tri.z).toBeCloseTo(X.z, 3)
    // The rejected mark is still reported — it just didn't steer the fit.
    expect(tri.viewCount).toBe(4)
    expect(tri.perViewReprojPx.find((o) => o.imageId === 'imgC').reprojPx).toBeGreaterThan(10)
  })

  it('drops a misclick that sits *inside* the widest-baseline seed pair', async () => {
    // The regression: seeding only from camA↔camB (the widest pair) puts the bad
    // mark in the seed, and the Huber fit resists outliers but cannot climb out of
    // the basin it was started in. Measured with a single seed pair, a misclick of
    // this size on imgB lands the point 270 world units from truth (and at ≥600 px,
    // ~7e5) even when stage 2 does reject it — the *final* refit inherits the
    // poisoned seed. Seeding from the few widest pairs gives the fit a clean basin
    // to prefer, and every magnitude recovers exactly.
    const observations = clean()
    observations[1] = { imageId: 'imgB', px: observations[1].px + 300, py: observations[1].py - 180 }

    const tri = await triangulateGcp(observations, cams, { robust: true })

    expect(tri.rejectedImageIds).toEqual(['imgB'])
    expect(tri.x).toBeCloseTo(X.x, 3)
    expect(tri.y).toBeCloseTo(X.y, 3)
    expect(tri.z).toBeCloseTo(X.z, 3)
    expect(tri.viewCount).toBe(4)
  })

  it('rejects nothing on a clean set (the absolute floor guards sub-pixel noise)', async () => {
    const observations = clean()
    observations[0].px += 0.4 // sub-pixel jitter, not a misclick
    const tri = await triangulateGcp(observations, cams, { robust: true })
    expect(tri.rejectedImageIds).toEqual([])
  })

  it('does not robustify a 2-view fit (rejection must leave a triangulable pair)', async () => {
    const observations = clean().slice(0, 2)
    observations[1].px += 60
    const tri = await triangulateGcp(observations, new Map([['imgA', camA], ['imgB', camB]]), { robust: true })
    expect(tri.rejectedImageIds).toEqual([])
    expect(tri.viewCount).toBe(2)
  })
})

describe('triangulateAllGcps', () => {
  it('skips disabled GCPs and maps imageId through imagesById → sparseCameras', async () => {
    const X = { x: 0.2, y: -0.1, z: 5 }
    const obsA = project(camA, X)
    const obsB = project(camB, X)
    const sparseCameras = new Map([['uuidA', camA], ['uuidB', camB]])
    const imagesById = new Map([['imgA', { uuid: 'uuidA' }], ['imgB', { uuid: 'uuidB' }]])
    const gcps = [
      {
        id: 'g1', x: 1, y: 2, z: 3, enabled: true,
        observations: [
          { imageId: 'imgA', px: obsA.px, py: obsA.py },
          { imageId: 'imgB', px: obsB.px, py: obsB.py },
        ],
      },
      { id: 'g2', x: 0, y: 0, z: 0, enabled: false, observations: [] },
    ]

    const results = await triangulateAllGcps(gcps, sparseCameras, imagesById)
    expect(results).toHaveLength(2)
    expect(results[0].tri).not.toBeNull()
    expect(results[0].tri.x).toBeCloseTo(X.x, 3)
    expect(results[1].tri).toBeNull()
  })
})
