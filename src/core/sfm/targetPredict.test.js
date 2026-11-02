import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { targetPredictions, quadRadiusFor, modelFromProject } from './targetPredict.js'
import { applySimilarity } from '../products/georef.js'
import { projectPoint } from './geometry.js'

// Node cannot fetch the .wasm the triangulation uses: hand init() its bytes.
beforeAll(async () => {
  const url = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(url)) })
})

const nadir = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
]
const K = { fx: 1000, fy: 1000, cx: 500, cy: 375 }
// A camera 50 units above (cx, cy): t = −R·C.
const cam = (x, y) => ({ R: nadir, t: [-x, y, 50], K })

describe('targetPredictions', () => {
  const cameras = new Map([
    ['a', cam(0, 0)],
    ['b', cam(10, 0)],
    ['c', cam(5, 8)],
  ])
  const X = [4, 3, 1]
  const mark = (id) => {
    const p = projectPoint(cameras.get(id), ...X)
    return { imageId: id, px: p.u, py: p.v }
  }

  it('triangulates a GCP marked elsewhere and sizes its target', async () => {
    const gcps = [{ id: 'g1', name: 'GCP1', observations: [mark('a'), mark('b')] }]
    const [p] = await targetPredictions({
      gcps,
      imageId: 'c',
      cam: cameras.get('c'),
      cameras,
      sizeM: 0.5,
      metresPerUnit: 1,
    })
    const want = projectPoint(cameras.get('c'), ...X)
    expect(p.u).toBeCloseTo(want.u, 6)
    expect(p.v).toBeCloseTo(want.v, 6)
    expect(p.depth).toBeCloseTo(49, 6)
    expect(p.halfPx).toBeCloseTo((0.25 * 1000) / 49, 6)
  })

  it('places a GCP with coordinates through the georeference, and skips marked or disabled ones', async () => {
    const gcps = [
      { id: 'g1', name: 'A', x: 104, y: 203, z: 1, observations: [] },
      { id: 'g2', name: 'B', x: 0, y: 0, z: 0, observations: [{ imageId: 'c', px: 1, py: 1 }] },
      { id: 'g3', name: 'C', x: 0, y: 0, z: 0, enabled: false, observations: [] },
      { id: 'g4', name: 'D', role: 'marker', observations: [] },
    ]
    const toModel = ([x, y, z]) => [x - 100, y - 200, z]
    const out = await targetPredictions({ gcps, imageId: 'c', cam: cameras.get('c'), cameras, toModel, sizeM: 0.5 })
    expect(out.map((p) => p.gcpId)).toEqual(['g1'])
    expect(out[0].halfPx).toBeNull()
    const want = projectPoint(cameras.get('c'), ...X)
    expect(out[0].u).toBeCloseTo(want.u, 9)
  })
})

describe('quadRadiusFor', () => {
  it('samples inside the mat, within bounds', () => {
    expect(quadRadiusFor(20)).toBe(12)
    expect(quadRadiusFor(2)).toBe(3)
    expect(quadRadiusFor(500)).toBe(60)
    expect(quadRadiusFor(null)).toBe(10)
  })
})

describe('modelFromProject', () => {
  it('inverts the georeference, with and without a local frame', () => {
    const c = Math.cos(0.3),
      sn = Math.sin(0.3)
    const sim = {
      scale: 2.5,
      R: [
        [c, -sn, 0],
        [sn, c, 0],
        [0, 0, 1],
      ],
      t: [500000, 4000000, 100],
    }
    const X = [3, -4, 1.5]
    const back = modelFromProject(sim, applySimilarity(sim, X))
    back.forEach((v, i) => expect(v).toBeCloseTo(X[i], 9))
    const local = { e0: 500000, n0: 4000000, k: 0.9996, R: 6371000 }
    const simL = { ...sim, t: [10, 20, 100], local }
    const backL = modelFromProject(simL, applySimilarity(simL, X))
    backL.forEach((v, i) => expect(v).toBeCloseTo(X[i], 6))
  })
})
