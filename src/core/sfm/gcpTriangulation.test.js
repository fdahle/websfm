import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { triangulateGcp, triangulateAllGcps } from './gcpTriangulation.js'

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
