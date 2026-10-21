import { describe, expect, it } from 'vitest'
import { compactPointRecords, packReconstructionResult, unpackReconstructionResult } from './resultCodec.js'
import { SparsePoints } from './sparsePoints.js'

const camera = (uuid) => ({
  uuid,
  R: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  t: [1, 2, 3],
  K: { fx: 100, fy: 101, cx: 50, cy: 40 },
})

function model(extra = {}) {
  return {
    status: 'done',
    cameras: [camera('a'), camera('b')],
    points: SparsePoints.fromRecords([
      {
        x: 1,
        y: 2,
        z: 3,
        color: [10, 20, 30],
        views: [
          ['a', 7, 1.25, 2.5],
          ['b', 9, 3.5, 4.75],
        ],
      },
      { x: -4, y: 5, z: 6, color: null, views: [['a', 2]] },
      { x: 0, y: 0, z: 0, color: [0, 0, 0], views: [] },
    ]),
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
    const views = [],
      pixels = []
    out.points.forEachView(0, (uuid, kp) => views.push([uuid, kp]))
    out.points.forEachPixel(0, (uuid, px, py) => pixels.push([uuid, [px, py]]))
    expect(views).toEqual([
      ['a', 7],
      ['b', 9],
    ])
    expect(pixels).toEqual([
      ['a', [1.25, 2.5]],
      ['b', [3.5, 4.75]],
    ])
    expect(out.points.pixelCount(1)).toBe(0)
    expect(out.points.colorAt(1)).toBeNull()
    expect(out.points.colorAt(2)).toEqual([0, 0, 0])
    // Restored as columns over the transferred buffers, not per-point Maps.
    expect(out.points).toBeInstanceOf(SparsePoints)
    expect(out.points.vcam).toBeInstanceOf(Uint32Array)
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
    const out = unpackReconstructionResult(
      packReconstructionResult({ status: 'error', cameras: [], points: SparsePoints.empty() }).result,
    )
    expect(out.status).toBe('error')
    expect(out.cameras.size).toBe(0)
    expect(out.points).toBeInstanceOf(SparsePoints)
    expect(out.points.length).toBe(0)
  })

  it('compacts mutable solver points without observation tuples and can consume them', () => {
    const solverPoints = [
      {
        x: 1,
        y: 2,
        z: 3,
        views: new Map([
          ['a', 4],
          ['b', 5],
        ]),
      },
    ]
    const points = compactPointRecords(solverPoints, {
      colorOf: () => [7, 8, 9],
      pixelOf: (uuid) => (uuid === 'a' ? [10.5, 20.5] : [30.5, 40.5]),
      consume: true,
    })
    expect(solverPoints).toEqual([null])
    expect(points.viewCount(0)).toBe(2)
    const uuids = []
    points.forEachView(0, (uuid) => uuids.push(uuid))
    expect(uuids).toEqual(['a', 'b'])
    expect(points.slotOf(0, 'b')).toBeGreaterThanOrEqual(0)
    expect(points.pixelOf(0, 'a')).toEqual([10.5, 20.5])

    // Repacking a compact model reuses its CSR buffers rather than allocating a
    // second observation payload.
    const { result } = packReconstructionResult({ status: 'done', cameras: [camera('a')], points })
    expect(result.buffers.vcam).toBe(points.vcam.buffer)
    expect(result.buffers.vx).toBe(points.vx.buffer)
  })
})
