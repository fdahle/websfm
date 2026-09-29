import { expect, it, vi } from 'vitest'
import { sparsePointMetrics, selectedSparseIndices, refineSparseSelection } from './gradualSelection.js'
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
