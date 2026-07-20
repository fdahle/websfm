import { describe, it, expect } from 'vitest'
import {
  serializeDepthMap, deserializeDepthMap, depthPlanesMissing,
  buildDepthIndex, isDepthIndexStale, depthMapBytes,
} from './depthMapCodec.js'

// A 2×3 depth map with distinct values per plane so a mix-up is visible.
function makeMap(overrides = {}) {
  const px = 6
  return {
    uuid: 'img-a',
    width: 2,
    height: 3,
    K: { fx: 100, fy: 101, cx: 1, cy: 1.5 },
    R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    t: [1, 2, 3],
    depth: Float32Array.from({ length: px }, (_, i) => i + 0.5),
    cost: Float32Array.from({ length: px }, (_, i) => i * 0.1),
    rgb: Uint8Array.from({ length: px * 3 }, (_, i) => i),
    normals: Float32Array.from({ length: px * 3 }, (_, i) => -i),
    displayDataUrl: 'data:image/png;base64,zzz',
    ...overrides,
  }
}

// Round-trip through the on-disk shape: serialize → (bytes) → deserialize.
function roundTrip(m) {
  const { meta, buffers } = serializeDepthMap(m)
  return deserializeDepthMap(JSON.parse(JSON.stringify(meta)), buffers)
}

describe('serialize/deserializeDepthMap', () => {
  it('round-trips planes and metadata', () => {
    const m = makeMap()
    const back = roundTrip(m)
    expect(back.uuid).toBe('img-a')
    expect(back.width).toBe(2)
    expect(back.height).toBe(3)
    expect(back.K).toEqual({ fx: 100, fy: 101, cx: 1, cy: 1.5 })
    expect(back.R).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    expect(back.t).toEqual([1, 2, 3])
    expect(Array.from(back.depth)).toEqual(Array.from(m.depth))
    expect(Array.from(back.cost)).toEqual(Array.from(m.cost))
    expect(Array.from(back.rgb)).toEqual(Array.from(m.rgb))
    expect(Array.from(back.normals)).toEqual(Array.from(m.normals))
  })

  it('drops the display PNG (the images store owns it)', () => {
    const { meta, buffers } = serializeDepthMap(makeMap())
    expect(meta.displayDataUrl).toBeUndefined()
    expect(buffers.displayDataUrl).toBeUndefined()
    expect(roundTrip(makeMap()).displayDataUrl).toBeUndefined()
  })

  it('round-trips a map without normals', () => {
    const { meta, buffers } = serializeDepthMap(makeMap({ normals: null }))
    expect(meta.hasNormals).toBe(false)
    expect(buffers.nrm).toBeNull()
    expect(deserializeDepthMap(meta, buffers).normals).toBeNull()
  })

  it('copies a plane that is a view onto a larger buffer', () => {
    // Persisting `ta.buffer` wholesale would write the neighbouring bytes too.
    const backing = new Float32Array([99, 99, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5])
    const m = makeMap({ depth: backing.subarray(2) })
    const { buffers } = serializeDepthMap(m)
    expect(buffers.depth.byteLength).toBe(6 * 4)
    expect(Array.from(new Float32Array(buffers.depth))).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5])
  })

  it('rejects a map whose planes are missing or the wrong size', () => {
    const { meta, buffers } = serializeDepthMap(makeMap())
    expect(deserializeDepthMap(meta, { ...buffers, depth: null })).toBeNull()
    expect(deserializeDepthMap(meta, { ...buffers, rgb: new ArrayBuffer(4) })).toBeNull()
    // A truncated write must not fuse as a partial plane.
    expect(deserializeDepthMap(meta, { ...buffers, cost: new ArrayBuffer(8) })).toBeNull()
    // Present-but-wrong-sized normals are corruption, not "no normals".
    expect(deserializeDepthMap(meta, { ...buffers, nrm: new ArrayBuffer(12) })).toBeNull()
    expect(deserializeDepthMap({ ...meta, width: 0 }, buffers)).toBeNull()
    expect(deserializeDepthMap(null, buffers)).toBeNull()
  })
})

describe('depthPlanesMissing', () => {
  // The store drops a missing map (its image was removed) but refuses the whole
  // saved set on a corrupt one — so this distinction decides which happens.
  it('reports absent sidecars as missing', () => {
    expect(depthPlanesMissing(null)).toBe(true)
    expect(depthPlanesMissing({ depth: null, cost: null, rgb: null, nrm: null })).toBe(true)
    expect(depthPlanesMissing({ depth: new ArrayBuffer(0), cost: null, rgb: null })).toBe(true)
  })

  it('does not report a partial read as missing (that is corruption)', () => {
    const { buffers } = serializeDepthMap(makeMap())
    expect(depthPlanesMissing(buffers)).toBe(false)
    expect(depthPlanesMissing({ ...buffers, depth: null, cost: null })).toBe(false)
  })
})

describe('buildDepthIndex', () => {
  it('stamps the sparse cloud identity and lists map metadata', () => {
    const cloud = { id: 'cloud-1', createdAt: 1000 }
    const index = buildDepthIndex([makeMap(), makeMap({ uuid: 'img-b' })],
      { sparseCloud: cloud, settings: { quality: 'high' } })
    expect(index.version).toBe(3)
    expect(index.sparseCloudId).toBe('cloud-1')
    expect(index.sparseCreatedAt).toBe(1000)
    expect(index.settings).toEqual({ quality: 'high' })
    expect(index.maps.map((m) => m.uuid)).toEqual(['img-a', 'img-b'])
    expect(index.maps[0].hasNormals).toBe(true)
    // coverage fields: all six depths are > 0, spanning 0.5..5.5.
    expect(index.maps[0].validPx).toBe(6)
    expect(index.maps[0].depthMin).toBeCloseTo(0.5, 6)
    expect(index.maps[0].depthMax).toBeCloseTo(5.5, 6)
    // v3 median: sorted [0.5,1.5,2.5,3.5,4.5,5.5], upper-middle = 3.5.
    expect(index.maps[0].depthMedian).toBeCloseTo(3.5, 6)
  })
})

describe('isDepthIndexStale', () => {
  const cloud = { id: 'cloud-1', createdAt: 1000 }
  const index = buildDepthIndex([makeMap()], { sparseCloud: cloud })

  it('accepts maps matching the current sparse cloud', () => {
    expect(isDepthIndexStale(index, { id: 'cloud-1', createdAt: 1000 })).toBe(false)
  })

  it('rejects maps from a re-run that kept the cloud id', () => {
    // upsertSparseCloud carries the previous id forward but refreshes createdAt,
    // so createdAt is the part that actually detects a rebuild.
    expect(isDepthIndexStale(index, { id: 'cloud-1', createdAt: 2000 })).toBe(true)
  })

  it('rejects maps from a different cloud, or with no cloud at all', () => {
    expect(isDepthIndexStale(index, { id: 'cloud-2', createdAt: 1000 })).toBe(true)
    expect(isDepthIndexStale(index, null)).toBe(true)
  })

  it('rejects an unstamped index rather than trusting it', () => {
    expect(isDepthIndexStale({ maps: [makeMap()] }, cloud)).toBe(true)
  })

  it('treats an empty/absent index as not stale (nothing to discard)', () => {
    expect(isDepthIndexStale(null, cloud)).toBe(false)
    expect(isDepthIndexStale({ maps: [] }, cloud)).toBe(false)
  })
})

describe('depthMapBytes', () => {
  it('sums the planes from metadata alone', () => {
    const index = buildDepthIndex([makeMap()], { sparseCloud: { id: 'c', createdAt: 1 } })
    // 6 px: depth 24 + cost 24 + rgb 18 + nrm 72
    expect(depthMapBytes(index.maps)).toBe(138)
  })

  it('excludes normals when the run produced none', () => {
    const index = buildDepthIndex([makeMap({ normals: null })], { sparseCloud: { id: 'c', createdAt: 1 } })
    expect(depthMapBytes(index.maps)).toBe(66)
  })
})
