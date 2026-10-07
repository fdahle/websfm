import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it, vi } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { sparsePointMetrics, selectedSparseIndices, refineSparseSelection, optimizeCameras } from './gradualSelection.js'
// GCP anchoring triangulates through the wasm DLT.
beforeAll(async () => {
  const bytes = await readFile(fileURLToPath(new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)))
  await initRecon({ module_or_path: bytes })
})
const R = [[1,0,0],[0,1,0],[0,0,1]], K = { fx: 100, fy: 100, cx: 0, cy: 0 }
const cameras = new Map([['a', { R, t: [0,0,0], K }], ['b', { R, t: [-1,0,0], K }]])
function points() { return Array.from({ length: 8 }, (_, i) => ({ x: i / 10, y: 0, z: 10, views: new Map([['a',i],['b',i]]), viewsPx: new Map([['a',[i, i === 7 ? 30 : 0]],['b',[i-10,0]]]), color: [1,2,3] })) }
it('computes RMS, track length and maximum camera-ray angle', () => {
  const metrics = sparsePointMetrics(cameras, points())
  expect(metrics[0].error).toBe(0)
  expect(metrics[0].track).toBe(2)
  expect(metrics[0].angle).toBeCloseTo(5.71059)
  expect(selectedSparseIndices(metrics, { metric: 'error', threshold: 3 })).toEqual([7])
})
it('preserves tracks/colors, remaps BA observations and keeps the input untouched', async () => {
  const input = points()
  const solver = vi.fn(async (cams, intr, pts) => ({ cameras: cams, points3d: pts.map(p => ({ x:p.x, y:p.y, z:p.z })), costBefore: 1, costAfter: .5 }))
  const result = await refineSparseSelection(cameras, input, { metric: 'error', threshold: 3 }, solver)
  expect(result.points).toHaveLength(7)
  expect(input).toHaveLength(8)
  expect(result.points[0].viewsPx).toEqual(input[0].viewsPx)
  expect(result.points[0].color).toEqual([1,2,3])
  expect(solver.mock.calls[0][3]).toHaveLength(14)
  expect(solver.mock.calls[0][3].at(-1).ptIdx).toBe(6)
})
it('refuses unsupported cameras and solver regressions without mutating the original', async () => {
  const solver = vi.fn(async () => ({ costBefore: 1, costAfter: 3, points3d: [] }))
  await expect(refineSparseSelection(cameras, points(), { metric: 'error', threshold: 3 }, solver)).rejects.toThrow('increased')
  await expect(refineSparseSelection(cameras, points(), { metric: 'track', threshold: 3 }, solver)).rejects.toThrow('six points')
})
it('refuses deletion of the only bridge between otherwise supported camera groups', async () => {
  const cams = new Map([...cameras, ['c', cameras.get('a')], ['d', cameras.get('b')]])
  const groupA = points().slice(0,6)
  const groupB = points().slice(0,6).map(p => ({...p, views:new Map([['c',0],['d',0]]), viewsPx:new Map([['c',p.viewsPx.get('a')],['d',p.viewsPx.get('b')]])}))
  const bridge = {x:0,y:0,z:10,views:new Map([...cams.keys()].map(id=>[id,0])),viewsPx:new Map([...cams.keys()].map(id=>[id,[999,999]]))}
  const solver = vi.fn()
  await expect(refineSparseSelection(cams,[...groupA,...groupB,bridge],{metric:'error',threshold:3},solver)).rejects.toThrow('disconnect')
  expect(solver).not.toHaveBeenCalled()
})
it('holds the refinement to GCP anchors and camera priors (survey frame = 2×SfM + offset)', async () => {
  // Three non-collinear cameras (centres (0,0,0), (1,0,0), (0,1,0)); exact marks.
  const cams = new Map([['a', { R, t: [0,0,0], K }], ['b', { R, t: [-1,0,0], K }], ['c', { R, t: [0,-1,0], K }]])
  const proj = (cam, [x, y, z]) => [100 * (x + cam.t[0]) / (z + cam.t[2]), 100 * (y + cam.t[1]) / (z + cam.t[2])]
  const world = Array.from({ length: 9 }, (_, i) => [i / 10 - 0.4, (i % 3) / 10, 10 + (i % 2)])
  const pts = world.map((w, i) => ({ x: w[0], y: w[1], z: w[2], color: [1,2,3],
    views: new Map([...cams.keys()].map(id => [id, i])),
    viewsPx: new Map([...cams].map(([id, c]) => [id, i === 8 ? [999, 999] : proj(c, w)])) }))
  const toSurvey = ([x, y, z]) => [2 * x + 500, 2 * y + 1000, 2 * z + 50]
  const gcpWorld = [[0, 0, 10], [1, 0, 12], [0, 1, 11]]
  const gcps = gcpWorld.map((w) => {
    const [x, y, z] = toSurvey(w)
    return { role: 'control', x, y, z, accuracyX: 0.05, accuracyY: 0.05, accuracyZ: 0.1,
      observations: [...cams].map(([uuid, c]) => { const [px, py] = proj(c, w); return { uuid, px, py, accuracyX: 1, accuracyY: 1 } }) }
  })
  const cameraPriors = [...cams].map(([uuid, c]) => {
    const [x, y, z] = toSurvey([-c.t[0], -c.t[1], -c.t[2]])
    return { uuid, x, y, z, accuracyX: 1, accuracyY: 1, accuracyZ: 2 }
  })
  // A constrained solve may raise the residual within the survey allowance.
  const solver = vi.fn(async (c, intr, p) => ({ cameras: c, points3d: p.map(q => ({ x: q.x, y: q.y, z: q.z })), costBefore: 1, costAfter: 1.2 }))
  const result = await refineSparseSelection(cams, pts, { metric: 'error', threshold: 3 }, solver, { gcps, cameraPriors })
  const opts = solver.mock.calls[0][4]
  expect(opts.gcpAnchors).toHaveLength(3)
  expect(opts.cameraPriors).toHaveLength(3)
  // Anchor targets land on the GCPs' SfM-frame positions; anchor points are scratch.
  opts.gcpAnchors.forEach((a, i) => a.target.forEach((v, k) => expect(v).toBeCloseTo(gcpWorld[i][k], 6)))
  expect(opts.gcpAnchors[0].ptIdx).toBe(8)
  expect(result.points).toHaveLength(8)
  expect(result.constraints).toMatchObject({ gcpAnchors: 3, cameraPriors: 3 })
  // The same +0.2 px is a regression when nothing constrains the solve.
  await expect(refineSparseSelection(cams, pts, { metric: 'error', threshold: 3 }, solver)).rejects.toThrow('increased')
})

it('optimizeCameras frees focal per sensor, keeps every point and pins the pinhole invariant', async () => {
  const input = points()
  const solver = vi.fn(async (cams, intr, pts) => ({
    cameras: cams, points3d: pts.map(p => ({ x: p.x, y: p.y, z: p.z })), costBefore: 2, costAfter: 1,
    intrinsics: intr.map(k => ({ ...k, fx: k.fx * 1.05, fy: k.fy * 1.05, k1: 0.3, k2: 0, k3: 0 })),
  }))
  const result = await optimizeCameras(cameras, input, { refine: 'f', sensorOfUuid: { a: 0, b: 0 } }, solver)
  const opts = solver.mock.calls[0][4]
  expect(opts.refineIntrinsics).toBe('f')
  expect(opts.sensorOfCam).toEqual([0, 0])
  expect(result.points).toHaveLength(8)
  expect(result.cameras.get('a').K).toEqual({ fx: 105, fy: 105, cx: 0, cy: 0 })
  // No radial term reaches the model even if the solver returned one.
  expect(result.cameras.get('a').K.k1).toBeUndefined()
  expect(input[0].x).toBe(0)
})

it('optimizeCameras refuses a focal runaway and radial refinement', async () => {
  const runaway = vi.fn(async (cams, intr, pts) => ({
    cameras: cams, points3d: pts.map(p => ({ x: p.x, y: p.y, z: p.z })), costBefore: 2, costAfter: 1,
    intrinsics: intr.map(k => ({ ...k, fx: k.fx * 2, fy: k.fy * 2 })),
  }))
  await expect(optimizeCameras(cameras, points(), { refine: 'f' }, runaway)).rejects.toThrow('runaway')
  await expect(optimizeCameras(cameras, points(), { refine: 'f,k1' }, runaway)).rejects.toThrow('Unsupported')
})

it('optimizeCameras recovers a 4 % focal error through the real WASM bundle adjustment', async () => {
  const { bundleAdjust } = await import('./reconstruction.js')
  const trueK = { fx: 1000, fy: 1000, cx: 0, cy: 0 }
  const rotY = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]]
  // Five cameras on an arc looking at a box of points 10 units away.
  const cams = new Map(Array.from({ length: 5 }, (_, i) => {
    const a = (i - 2) * 0.12
    const R = rotY(-a)
    const C = [10 * Math.sin(a), 0.3 * i, 10 - 10 * Math.cos(a)]
    const t = R.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
    return [`c${i}`, { R, t, K: { ...trueK, fx: 960, fy: 960 } }]
  }))
  const proj = (cam, [x, y, z]) => {
    const p = cam.R.map((row, k) => row[0] * x + row[1] * y + row[2] * z + cam.t[k])
    return [trueK.fx * p[0] / p[2], trueK.fy * p[1] / p[2]]
  }
  let seed = 3
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  const pts = Array.from({ length: 120 }, () => {
    const w = [rnd() * 6 - 3, rnd() * 4 - 2, 10 + rnd() * 4 - 2]
    return { x: w[0], y: w[1], z: w[2], views: new Map([...cams.keys()].map((id) => [id, 0])),
      viewsPx: new Map([...cams].map(([id, c]) => [id, proj(c, w)])) }
  })
  const sensorOfUuid = Object.fromEntries([...cams.keys()].map((id) => [id, 0]))
  const result = await optimizeCameras(cams, pts, { refine: 'f', sensorOfUuid }, bundleAdjust)
  const fx = result.cameras.get('c0').K.fx
  expect(Math.abs(fx / 1000 - 1)).toBeLessThan(0.005)
  expect(result.costAfter).toBeLessThan(result.costBefore)
  // Shared per sensor: one focal for all five.
  for (const c of result.cameras.values()) expect(c.K.fx).toBeCloseTo(fx, 6)
})
