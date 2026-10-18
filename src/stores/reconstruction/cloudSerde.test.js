import { describe, expect, it } from 'vitest'
import {
  serializeCloud, deserializeCloud,
} from './cloudSerde.js'
import { SparsePoints } from '../../core/sfm/sparsePoints.js'

let seq = 0
const makeCloudId = () => `minted-${seq++}`

// serialize() hands back ArrayBuffers; a real round trip goes through OPFS, so
// re-wrap them exactly as the reader does.
const roundTrip = (cloud) => deserializeCloud(serializeCloud(cloud), makeCloudId)

// Point records, wrapped into a SparsePoints by sparseCloud (tests may edit them first).
const sparseRecords = () => [
  { x: 1, y: 2, z: 3, color: [10, 20, 30], views: new Map([['ua', 7], ['ub', 9]]), viewsPx: new Map([['ua', [1.5, 2.5]], ['ub', [3.5, 4.5]]]) },
  { x: -4, y: 5, z: 6, color: [40, 50, 60], views: new Map([['ua', 2]]), viewsPx: new Map() },
  { x: 0, y: 0, z: 0, color: [0, 0, 0], views: new Map(), viewsPx: new Map() },
]

function sparseCloud(overrides = {}, records = sparseRecords()) {
  return {
    id: 'c1', name: 'Sparse cloud', kind: 'sparse', createdAt: 1000,
    cameras: new Map([
      ['ua', { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0], K: { fx: 100, fy: 100, cx: 50, cy: 40 } }],
      ['ub', { R: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], t: [1, 2, 3], K: { fx: 110, fy: 110, cx: 50, cy: 40 } }],
    ]),
    points: SparsePoints.fromRecords(records),
    ...overrides,
  }
}

const xyzs = (pts) => Array.from({ length: pts.length }, (_, i) => pts.xyz(i))
const colors = (pts) => Array.from({ length: pts.length }, (_, i) => pts.colorAt(i))
const viewsOf = (pts, i) => { const out = []; pts.forEachView(i, (u, kp) => out.push([u, kp])); return out }

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
    expect(xyzs(out.points)).toEqual([[1, 2, 3], [-4, 5, 6], [0, 0, 0]])
    expect(colors(out.points)).toEqual([[10, 20, 30], [40, 50, 60], [0, 0, 0]])
  })

  // The CSR layout (vcount + flattened vcam/vkp) is the part most likely to drift.
  it('preserves per-point view tracks across the CSR layout', () => {
    const out = roundTrip(sparseCloud())
    expect(viewsOf(out.points, 0).sort()).toEqual([['ua', 7], ['ub', 9]])
    expect(viewsOf(out.points, 1)).toEqual([['ua', 2]])
    expect(out.points.viewCount(2)).toBe(0)
  })

  it('preserves per-view pixels, and leaves them absent where unrecorded', () => {
    const out = roundTrip(sparseCloud())
    expect(out.points.pixelOf(0, 'ua')).toEqual([1.5, 2.5])
    expect(out.points.pixelOf(0, 'ub')).toEqual([3.5, 4.5])
    // Point 1 has a view but no pixel for it — NaN marks that, so nothing is set.
    expect(out.points.pixelCount(1)).toBe(0)
    expect(out.points.pixelOf(1, 'ua')).toBeUndefined()
  })

  it('omits the pixel buffers entirely when no point carries one', () => {
    const records = sparseRecords()
    for (const p of records) p.viewsPx = new Map()
    const ser = serializeCloud(sparseCloud({}, records))
    expect(ser.buffers.vx).toBe(null)
    expect(ser.buffers.vy).toBe(null)
    const back = deserializeCloud(ser, makeCloudId).points
    expect(back.hasPixels).toBe(false)
    expect(back.pixelCount(0)).toBe(0)
  })

  it('dictionary-encodes a view uuid that is not among the cameras', () => {
    const records = sparseRecords()
    records[0].views.set('stray', 5)
    const out = roundTrip(sparseCloud({}, records))
    expect(out.points.kpOf(0, 'stray')).toBe(5)
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
    const records = sparseRecords()
    for (const p of records) delete p.color
    const ser = serializeCloud(sparseCloud({}, records))
    expect(ser.hasColor).toBe(false)
    expect(deserializeCloud(ser, makeCloudId).points.colorAt(0)).toBeNull()
  })

  it('preserves missing colour separately from true black', () => {
    const records = sparseRecords()
    delete records[1].color
    const once = roundTrip(sparseCloud({}, records))
    expect(colors(once.points)).toEqual([[10, 20, 30], null, [0, 0, 0]])
    // The second save writes a restored cloud's own columns back out.
    const twice = roundTrip(once)
    expect(colors(twice.points)).toEqual([[10, 20, 30], null, [0, 0, 0]])
  })

  it('handles an empty cloud', () => {
    const out = roundTrip({ id: 'e', name: 'E', kind: 'sparse', createdAt: 1, cameras: new Map(), points: SparsePoints.empty() })
    expect(out.points.length).toBe(0)
    expect(out.cameras.size).toBe(0)
  })

  it('reuses restored CSR tracks while serializing updated point positions', () => {
    const restored = roundTrip(sparseCloud())
    const pos = restored.points.pos.slice()
    pos[0] = 99
    const moved = { ...restored, points: restored.points.withPositions(pos) }
    const ser = serializeCloud(moved)
    expect(new Float64Array(ser.buffers.pos)[0]).toBe(99)
    expect(ser.buffers.vcam).toBe(restored.points.vcam.buffer)
    expect(viewsOf(deserializeCloud(ser, makeCloudId).points, 0))
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

  it('preserves the flat layout, storing a Float32 cloud as Float32 (12 bytes/point)', () => {
    const ser = serializeCloud(dense())
    expect(ser.buffers.pos.byteLength).toBe(2 * 12)
    const out = deserializeCloud(ser, makeCloudId)
    expect(out.kind).toBe('dense')
    expect(out.count).toBe(2)
    expect([...out.pos]).toEqual([1, 2, 3, 4, 5, 6])
    expect([...out.col]).toEqual([10, 20, 30, 40, 50, 60])
    expect(out.pos).toBeInstanceOf(Float32Array)
    // A view on the read buffer, not a copy.
    expect(out.pos.buffer).toBe(ser.buffers.pos)
  })

  it('still reads an older save that widened pos to Float64', () => {
    const ser = serializeCloud(dense())
    const wide = new Float64Array(new Float32Array(ser.buffers.pos))
    const out = deserializeCloud({ ...ser, buffers: { ...ser.buffers, pos: wide.buffer } }, makeCloudId)
    expect(out.pos).toBeInstanceOf(Float32Array)
    expect([...out.pos]).toEqual([1, 2, 3, 4, 5, 6])
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

  it('carries its level-of-detail octree, unless it describes other points', () => {
    const lod = { dataFile: 'd1-x.lod', hierarchyFile: 'd1-x.hier', points: 2, nodeCount: 1, root: { min: [1, 2, 3], size: 3 }, cloudCreatedAt: 2000 }
    const out = roundTrip(dense({ lod }))
    expect(out.lod).toEqual(lod)
    expect(serializeCloud(dense({ lod }), { reuse: { pos: { name: 'p', bytes: 24 } } }).lod).toEqual(lod)
    expect('lod' in roundTrip(dense())).toBe(false)
    expect('lod' in roundTrip(dense({ lod: { ...lod, points: 5 } }))).toBe(false)
    // Same count, another generation (a reclassify renews createdAt): not its octree.
    expect('lod' in roundTrip(dense({ createdAt: 2001, lod }))).toBe(false)
    const { cloudCreatedAt: _g, ...unstamped } = lod
    expect('lod' in roundTrip(dense({ lod: unstamped }))).toBe(false)
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

  it('round-trips a texture: UVs, the page bytes, the page table and the face groups', () => {
    const texture = {
      data: Uint8Array.from([0xff, 0xd8, 1, 2, 0xff, 0xd8, 3]),
      pages: [{ width: 64, height: 32, offset: 0, length: 4, type: 'image/jpeg' },
        { width: 64, height: 8, offset: 4, length: 3, type: 'image/jpeg' }],
      groups: [{ page: 0, start: 0, count: 1 }, { page: 1, start: 1, count: 1 }],
    }
    const uv = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8])
    const textureSummary = { charts: 2, scale: 1 }
    const ser = serializeCloud({ ...mesh, uv, texture, textureSummary })
    expect(ser.texture.bytes).toBe(7)
    const out = deserializeCloud(ser, makeCloudId)
    expect([...out.uv]).toEqual([...uv])
    expect([...out.texture.data]).toEqual([...texture.data])
    expect(out.texture.pages).toEqual(texture.pages)
    expect(out.texture.groups).toEqual(texture.groups)
    expect(out.textureSummary).toEqual(textureSummary)
    expect(roundTrip(mesh).uv).toBeUndefined()
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
