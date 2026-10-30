import { describe, it, expect } from 'vitest'
import { depthMapsKey, reusableDepthMaps, depthCameraKey } from './depthReuse.js'

const cam = (x) => ({
  R: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  t: [x, 0, 0],
  K: { fx: 1000, fy: 1000, cx: 500, cy: 400 },
})
const meta = (uuid) => ({ uuid, width: 100, height: 80 })

describe('depthMapsKey', () => {
  it('ignores where the maps are computed, but not what shapes them', () => {
    const s = { quality: 'medium', method: 'fast', maxSources: 10 }
    expect(depthMapsKey({ ...s, memBudgetBytes: 1, useGpu: true })).toBe(depthMapsKey({ ...s, memBudgetBytes: 2 }))
    expect(depthMapsKey({ ...s, quality: 'high' })).not.toBe(depthMapsKey(s))
  })
  it('keys Auto by the method it resolves to', () => {
    expect(depthMapsKey({ method: 'auto', useGpu: true })).toBe(depthMapsKey({ method: 'full', useGpu: false }))
    expect(depthMapsKey({ method: 'auto', useGpu: false })).toBe(depthMapsKey({ method: 'fast' }))
  })
})

describe('reusableDepthMaps', () => {
  const cloud = {
    id: 's',
    createdAt: 5,
    cameras: new Map([
      ['a', cam(0)],
      ['b', cam(1)],
      ['c', cam(2)],
    ]),
  }
  const key = depthMapsKey({ quality: 'medium' })
  const keys = (o) => Object.fromEntries(Object.entries(o).map(([u, c]) => [u, depthCameraKey(c)]))
  const index = {
    sparseCloudId: 's',
    sparseCreatedAt: 5,
    mapsKey: key,
    cameraKeys: keys({ a: cam(0), b: cam(1.5), gone: cam(3) }),
    maps: [meta('a'), meta('b'), meta('gone')],
  }
  const now = keys({ a: cam(0), b: cam(1), c: cam(2) })
  it('keeps a map whose camera is unchanged, not one that moved or left', () => {
    expect(reusableDepthMaps({ index, cloud, key, cameraKeys: now }).map((m) => m.uuid)).toEqual(['a'])
  })
  it('sees a lens change as a moved camera', () => {
    const lens = keys({ a: { ...cam(0), selfCal: { k1: 0.01 } } })
    expect(reusableDepthMaps({ index, cloud, key, cameraKeys: lens })).toEqual([])
  })
  it('keeps nothing after a rebuild, with other settings, or from an index without a key', () => {
    expect(reusableDepthMaps({ index, cloud: { ...cloud, createdAt: 6 }, key, cameraKeys: now })).toEqual([])
    expect(reusableDepthMaps({ index, cloud, key: depthMapsKey({ quality: 'high' }), cameraKeys: now })).toEqual([])
    expect(reusableDepthMaps({ index: { ...index, mapsKey: undefined }, cloud, key, cameraKeys: now })).toEqual([])
  })
})
