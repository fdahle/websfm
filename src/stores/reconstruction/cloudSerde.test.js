import { describe, expect, it } from 'vitest'
import {
  serializeCloud, deserializeCloud, legacyDeserializeCloud,
} from './cloudSerde.js'

let seq = 0
const makeCloudId = () => `minted-${seq++}`

// serialize() hands back ArrayBuffers; a real round trip goes through OPFS, so
// re-wrap them exactly as the reader does.
const roundTrip = (cloud) => deserializeCloud(serializeCloud(cloud), makeCloudId)

function sparseCloud(overrides = {}) {
  return {
    id: 'c1', name: 'Sparse cloud', kind: 'sparse', createdAt: 1000,
    cameras: new Map([
      ['ua', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K: { fx: 100, fy: 100, cx: 50, cy: 40 } }],
      ['ub', { R: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], t: [1, 2, 3], K: { fx: 110, fy: 110, cx: 50, cy: 40 } }],
    ]),
    points: [
      { x: 1, y: 2, z: 3, color: [10, 20, 30], views: new Map([['ua', 7], ['ub', 9]]), viewsPx: new Map([['ua', [1.5, 2.5]], ['ub', [3.5, 4.5]]]) },
      { x: -4, y: 5, z: 6, color: [40, 50, 60], views: new Map([['ua', 2]]), viewsPx: new Map() },
      { x: 0, y: 0, z: 0, color: [0, 0, 0], views: new Map(), viewsPx: new Map() },
    ],
    ...overrides,
  }
}

describe('sparse cloud round trip', () => {
  it('preserves metadata, cameras, positions and colours', () => {
    const out = roundTrip(sparseCloud())
    expect(out.id).toBe('c1')
    expect(out.name).toBe('Sparse cloud')
    expect(out.kind).toBe('sparse')
    expect(out.createdAt).toBe(1000)
    expect([...out.cameras.keys()]).toEqual(['ua', 'ub'])
    expect(out.cameras.get('ub')).toEqual({
      R: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], t: [1, 2, 3], K: { fx: 110, fy: 110, cx: 50, cy: 40 },
    })
    expect(out.points.map((p) => [p.x, p.y, p.z])).toEqual([[1, 2, 3], [-4, 5, 6], [0, 0, 0]])
    expect(out.points.map((p) => p.color)).toEqual([[10, 20, 30], [40, 50, 60], [0, 0, 0]])
  })

  // The CSR layout (vcount + flattened vcam/vkp) is the part most likely to drift.
  it('preserves per-point view tracks across the CSR layout', () => {
    const out = roundTrip(sparseCloud())
    expect([...out.points[0].views.entries()].sort()).toEqual([['ua', 7], ['ub', 9]])
    expect([...out.points[1].views.entries()]).toEqual([['ua', 2]])
    expect(out.points[2].views.size).toBe(0)
  })

  it('preserves per-view pixels, and leaves them absent where unrecorded', () => {
    const out = roundTrip(sparseCloud())
    expect(out.points[0].viewsPx.get('ua')).toEqual([1.5, 2.5])
    expect(out.points[0].viewsPx.get('ub')).toEqual([3.5, 4.5])
    // Point 1 has a view but no pixel for it — NaN marks that, so nothing is set.
    expect(out.points[1].viewsPx).toBeUndefined()
  })

  it('omits the pixel buffers entirely when no point carries one', () => {
    const c = sparseCloud()
    for (const p of c.points) p.viewsPx = new Map()
    const ser = serializeCloud(c)
    expect(ser.buffers.vx).toBe(null)
    expect(ser.buffers.vy).toBe(null)
    expect(deserializeCloud(ser, makeCloudId).points[0].viewsPx).toBeUndefined()
  })

  it('dictionary-encodes a view uuid that is not among the cameras', () => {
    const c = sparseCloud()
    c.points[0].views.set('stray', 5)
    const out = roundTrip(c)
    expect(out.points[0].views.get('stray')).toBe(5)
  })

  it('carries the imported and secondary flags, and omits them otherwise', () => {
    const plain = roundTrip(sparseCloud())
    expect('imported' in plain).toBe(false)
    expect('secondary' in plain).toBe(false)
    const flagged = roundTrip(sparseCloud({ imported: true, secondary: true }))
    expect(flagged.imported).toBe(true)
    expect(flagged.secondary).toBe(true)
  })

  it('drops colour when no point has any', () => {
    const c = sparseCloud()
    for (const p of c.points) delete p.color
    const ser = serializeCloud(c)
    expect(ser.hasColor).toBe(false)
    expect(deserializeCloud(ser, makeCloudId).points[0].color).toBeUndefined()
  })

  it('preserves missing colour separately from true black', () => {
    const c = sparseCloud()
    delete c.points[1].color
    const once = roundTrip(c)
    expect(once.points.map((p) => p.color)).toEqual([[10, 20, 30], undefined, [0, 0, 0]])
    // The second save takes the packed-track fast path used by restored projects.
    const twice = roundTrip(once)
    expect(twice.points.map((p) => p.color)).toEqual([[10, 20, 30], undefined, [0, 0, 0]])
  })

  it('handles an empty cloud', () => {
    const out = roundTrip({ id: 'e', name: 'E', kind: 'sparse', createdAt: 1, cameras: new Map(), points: [] })
    expect(out.points).toEqual([])
    expect(out.cameras.size).toBe(0)
  })

  it('reuses restored CSR tracks while serializing updated point positions', () => {
    const restored = roundTrip(sparseCloud())
    expect(restored.points.packedTracks).toBeTruthy()
    restored.points[0].x = 99
    const ser = serializeCloud(restored)
    expect(new Float64Array(ser.buffers.pos)[0]).toBe(99)
    expect(ser.buffers.vcam).toBe(restored.points.packedTracks.vcam.buffer)
    expect([...deserializeCloud(ser, makeCloudId).points[0].views.entries()])
      .toEqual([['ua', 7], ['ub', 9]])
  })
})

describe('dense cloud round trip', () => {
  const dense = (extra = {}) => ({
    id: 'd1', name: 'Dense', kind: 'dense', createdAt: 2000, count: 2,
    pos: Float32Array.from([1, 2, 3, 4, 5, 6]),
    col: Uint8Array.from([10, 20, 30, 40, 50, 60]),
    ...extra,
  })

  it('preserves the flat layout through the Float64 on-disk widening', () => {
    const out = roundTrip(dense())
    expect(out.kind).toBe('dense')
    expect(out.count).toBe(2)
    expect([...out.pos]).toEqual([1, 2, 3, 4, 5, 6])
    expect([...out.col]).toEqual([10, 20, 30, 40, 50, 60])
    expect(out.pos).toBeInstanceOf(Float32Array)
  })

  it('round-trips normals when present and leaves them undefined when not', () => {
    const withNrm = roundTrip(dense({ nrm: Float32Array.from([0, 0, 1, 0, 1, 0]) }))
    expect([...withNrm.nrm]).toEqual([0, 0, 1, 0, 1, 0])
    // Absent on legacy/normal-less runs — must stay undefined, never healed to zeros.
    expect(roundTrip(dense()).nrm).toBeUndefined()
  })

  it('carries imported and derived independently', () => {
    const out = roundTrip(dense({ imported: true, derived: true }))
    expect(out.imported).toBe(true)
    expect(out.derived).toBe(true)
    const plain = roundTrip(dense())
    expect('imported' in plain).toBe(false)
    expect('derived' in plain).toBe(false)
  })

  it('ignores buffer tail beyond count', () => {
    const c = dense({ count: 1, pos: Float32Array.from([1, 2, 3, 9, 9, 9]), col: Uint8Array.from([1, 2, 3, 9, 9, 9]) })
    const out = roundTrip(c)
    expect(out.count).toBe(1)
    expect([...out.pos]).toEqual([1, 2, 3])
  })
})

describe('mesh cloud round trip', () => {
  const mesh = {
    id: 'm1', name: 'Mesh', kind: 'mesh', createdAt: 3000,
    count: 2, nVerts: 4,
    pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    col: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    idx: Uint32Array.from([0, 1, 2, 1, 3, 2]),
  }

  it('preserves vertices, triangles and per-vertex colour', () => {
    const out = roundTrip(mesh)
    expect(out.kind).toBe('mesh')
    expect(out.nVerts).toBe(4)
    expect(out.count).toBe(2) // triangles
    expect([...out.idx]).toEqual([0, 1, 2, 1, 3, 2])
    expect([...out.pos]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0])
    expect([...out.col]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })

  it('round-trips the mesh run record, and leaves it absent on older meshes', () => {
    const meshSummary = { depth: 8, trim: 'gentle', sourceId: 'd2', stats: { keptTris: 2 } }
    expect(roundTrip({ ...mesh, meshSummary }).meshSummary).toEqual(meshSummary)
    expect(roundTrip(mesh).meshSummary).toBeUndefined()
  })

  // A re-mesh replaces only the computed mesh slot; losing the flag on reload would
  // let it overwrite the user's edited (Mesh ▾ tool) copy.
  it('round-trips the derived flag, absent ⇒ not derived', () => {
    expect(roundTrip({ ...mesh, derived: true }).derived).toBe(true)
    expect(roundTrip(mesh).derived).toBeUndefined()
  })
})

describe('legacy (pre-binary) documents', () => {
  it('reads an inline sparse cloud', () => {
    const out = legacyDeserializeCloud({
      id: 'L', name: 'Old', kind: 'sparse', createdAt: 5,
      cameras: [{ uuid: 'ua', R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K: { fx: 1 } }],
      points: [{ x: 1, y: 2, z: 3, color: [1, 2, 3], views: [['ua', 4]] }],
    }, makeCloudId)
    expect(out.cameras.get('ua').K).toEqual({ fx: 1 })
    expect([...out.points[0].views.entries()]).toEqual([['ua', 4]])
  })

  it('folds a legacy object-shaped dense cloud into the flat layout', () => {
    const out = legacyDeserializeCloud({
      kind: 'dense',
      points: [{ x: 1, y: 2, z: 3, color: [9, 8, 7] }, { x: 4, y: 5, z: 6 }],
    }, makeCloudId)
    expect(out.count).toBe(2)
    expect([...out.pos]).toEqual([1, 2, 3, 4, 5, 6])
    expect([...out.col]).toEqual([9, 8, 7, 200, 200, 200]) // default grey
  })

  it('mints an id when a legacy doc has none', () => {
    const out = legacyDeserializeCloud({ kind: 'sparse', points: [] }, makeCloudId)
    expect(out.id).toMatch(/^minted-/)
  })
})

it('preserves imported survey coordinates through dense and mesh persistence', () => {
  for (const kind of ['dense', 'mesh']) {
    const pos = new Float64Array([7000000.01, 500000.01, 100, 7000000.02, 500000.02, 101])
    const cloud = { id: 'survey', kind, imported: true, count: 2, nVerts: 2, pos, col: null, idx: new Uint32Array() }
    const out = roundTrip(cloud)
    expect(out.pos).toBeInstanceOf(Float64Array)
    expect(out.pos).toEqual(pos)
    expect(out.pos[0]).not.toBe(out.pos[3])
  }
})

describe('damaged attribute sidecar', () => {
  it('drops the attributes, keeps the cloud, and reports why', () => {
    const cloud = { id: 'd', name: 'd', kind: 'dense', count: 2, pos: new Float32Array(6), col: new Uint8Array(6),
      attributes: { intensity: new Uint16Array([1, 2]) } }
    const ser = serializeCloud(cloud)
    ser.buffers.attributes = new ArrayBuffer(1) // truncated
    const back = deserializeCloud(ser, makeCloudId)
    expect(back.count).toBe(2)
    expect(back.attributes).toBeUndefined()
    expect(back.attributeError).toMatch(/intensity/)
  })
})

describe('metadata-only serialisation (buffer reuse)', () => {
  const files = { pos: { name: 'p.bin', bytes: 48 } }
  const strip = ({ buffers, reuse, ...meta }) => meta
  const clouds = {
    dense: {
      id: 'd1', name: 'Dense', kind: 'dense', createdAt: 2000, count: 2, visible: false,
      style: { mode: 'height' }, imported: true,
      pos: Float32Array.from([1, 2, 3, 4, 5, 6]), col: Uint8Array.from([1, 2, 3, 4, 5, 6]),
      nrm: Float32Array.from([0, 0, 1, 0, 0, 1]), attributes: { intensity: Uint16Array.from([7, 8]) },
    },
    mesh: {
      id: 'm1', name: 'Mesh', kind: 'mesh', createdAt: 3000, count: 1, nVerts: 3, meshSummary: { depth: 8 },
      pos: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), idx: Uint32Array.from([0, 1, 2]),
    },
  }

  it.each(Object.keys(clouds))('writes the same metadata as a full save, and no buffers (%s)', (kind) => {
    const c = clouds[kind]
    const full = serializeCloud(c)
    const lite = serializeCloud(c, { reuse: files })
    expect(strip(lite)).toEqual(strip(full))
    expect(lite.buffers).toBeNull()
    expect(lite.reuse).toBe(files)
  })

  it('never reuses a sparse cloud: it always serialises in full', () => {
    const out = serializeCloud(sparseCloud(), { reuse: files })
    expect(out.reuse).toBeUndefined()
    expect(out.buffers.pos.byteLength).toBe(3 * 24)
  })
})
