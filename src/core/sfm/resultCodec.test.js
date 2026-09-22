import { describe, expect, it } from 'vitest'
import { compactPointRecords, packReconstructionResult, unpackReconstructionResult } from './resultCodec.js'

const camera = (uuid) => ({
  uuid,
  R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  t: [1, 2, 3],
  K: { fx: 100, fy: 101, cx: 50, cy: 40 },
})

function model(extra = {}) {
  return {
    status: 'done',
    cameras: [camera('a'), camera('b')],
    points: [
      { x: 1, y: 2, z: 3, color: [10, 20, 30], views: [['a', 7, 1.25, 2.5], ['b', 9, 3.5, 4.75]] },
      { x: -4, y: 5, z: 6, color: null, views: [['a', 2]] },
      { x: 0, y: 0, z: 0, color: [0, 0, 0], views: [] },
    ],
    summary: { nCameras: 2, nPoints: 3 },
    ...extra,
  }
}

describe('sparse reconstruction worker transport', () => {
  it('packs every large numeric field into transferable buffers', () => {
    const { result, transfer } = packReconstructionResult(model())
    expect(result.points).toBeUndefined()
    expect(result.pointCount).toBe(3)
    expect(result.viewUuids).toEqual(['a', 'b'])
    expect(transfer.length).toBe(8)
    expect(transfer.every((buffer) => buffer instanceof ArrayBuffer)).toBe(true)
    expect(new Uint32Array(result.buffers.vcount)).toEqual(Uint32Array.from([2, 1, 0]))
  })

  it('round-trips cameras, tracks, pixels, missing colour, and black colour', () => {
    const out = unpackReconstructionResult(packReconstructionResult(model()).result)
    expect(out.status).toBe('done')
    expect(out.summary).toEqual({ nCameras: 2, nPoints: 3 })
    expect([...out.cameras.keys()]).toEqual(['a', 'b'])
    expect([...out.points[0].views.entries()]).toEqual([['a', 7], ['b', 9]])
    expect([...out.points[0].viewsPx.entries()]).toEqual([['a', [1.25, 2.5]], ['b', [3.5, 4.75]]])
    expect(out.points[1].viewsPx).toBeUndefined()
    expect(out.points[1].color).toBeNull()
    expect(out.points[2].color).toEqual([0, 0, 0])
    expect(out.points.packedTracks.vcam).toBeInstanceOf(Uint32Array)
    expect(out.points[0].views).toBeInstanceOf(Object)
    expect(out.points[0].views).not.toBeInstanceOf(Map)
  })

  it('packs and restores separate secondary models and their metadata', () => {
    const secondary = model({ name: 'Secondary sparse 1', componentImageUuids: ['b'] })
    const { result, transfer } = packReconstructionResult(model({ secondaryModels: [secondary] }))
    const out = unpackReconstructionResult(result)
    expect(out.secondaryModels).toHaveLength(1)
    expect(out.secondaryModels[0].name).toBe('Secondary sparse 1')
    expect(out.secondaryModels[0].componentImageUuids).toEqual(['b'])
    expect(out.secondaryModels[0].points).toHaveLength(3)
    expect(transfer.length).toBe(16)
  })

  it('handles empty and non-success results', () => {
    const out = unpackReconstructionResult(packReconstructionResult({ status: 'error', cameras: [], points: [] }).result)
    expect(out.status).toBe('error')
    expect(out.cameras.size).toBe(0)
    expect(out.points).toEqual([])
  })

  it('compacts mutable solver points without observation tuples and can consume them', () => {
    const solverPoints = [
      { x: 1, y: 2, z: 3, views: new Map([['a', 4], ['b', 5]]) },
    ]
    const points = compactPointRecords(solverPoints, {
      colorOf: () => [7, 8, 9],
      pixelOf: (uuid) => uuid === 'a' ? [10.5, 20.5] : [30.5, 40.5],
      consume: true,
    })
    expect(solverPoints).toEqual([null])
    expect(points[0].views.length).toBe(2)
    expect(points[0].views.map(([uuid]) => uuid)).toEqual(['a', 'b'])
    expect(points[0].views.some(([uuid]) => uuid === 'b')).toBe(true)
    expect(points[0].viewsPx.get('a')).toEqual([10.5, 20.5])

    // Repacking a compact model reuses its CSR buffers rather than allocating a
    // second observation payload.
    const tracks = points.packedTracks
    const { result } = packReconstructionResult({ status: 'done', cameras: [camera('a')], points })
    expect(result.buffers.vcam).toBe(tracks.vcam.buffer)
    expect(result.buffers.vx).toBe(tracks.vx.buffer)
  })
})
