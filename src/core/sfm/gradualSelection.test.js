import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, expect, it, vi } from 'vitest'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { sparsePointMetrics, selectedSparseIndices, refineSparseSelection } from './gradualSelection.js'
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
