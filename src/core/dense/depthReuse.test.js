import { describe, it, expect } from 'vitest'
import { depthMapsKey, depthRunShape, reusableDepthMaps, depthCameraKey } from './depthReuse.js'

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

describe('depthMapsKey of depthRunShape', () => {
  const key = (s, o) => depthMapsKey(depthRunShape(s, { nativeLong: 4000, ...o }))
  it('ignores where the maps are computed, but not what shapes them', () => {
    const s = { quality: 'medium', method: 'fast', maxSources: 10 }
    expect(key({ ...s, memBudgetBytes: 1, useGpu: true })).toBe(key({ ...s, memBudgetBytes: 2 }))
    expect(key({ ...s, quality: 'high' })).not.toBe(key(s))
  })
  it('keys Auto by the method that ran: a GPU asked for but absent is Fast', () => {
    expect(key({ method: 'auto', useGpu: true }, { onGpu: true })).toBe(key({ method: 'full' }))
    expect(key({ method: 'auto', useGpu: true }, { onGpu: false })).toBe(key({ method: 'fast' }))
  })
  it('keys the resolution the run used, the region and the scene type', () => {
    const s = { quality: 'high', method: 'fast' }
    // A memory step-down (High → Medium) is a different map.
    expect(key(s, { maxDim: 1000 })).not.toBe(key(s))
    expect(key(s, { region: { min: [0, 0, 0], max: [1, 1, 1] } })).not.toBe(key(s))
    expect(key(s, { sceneType: 'object' })).not.toBe(key(s, { sceneType: 'aerial' }))
    // Larger originals added change what Quality means.
    expect(key(s, { nativeLong: 6000 })).not.toBe(key(s))
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
  const key = depthMapsKey(depthRunShape({ quality: 'medium' }))
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
  it('sees a lens or mask change as a moved camera', () => {
    const lens = keys({ a: { ...cam(0), selfCal: { k1: 0.01 } } })
    expect(reusableDepthMaps({ index, cloud, key, cameraKeys: lens })).toEqual([])
    const masked = keys({ a: { ...cam(0), maskKey: 1234 } })
    expect(reusableDepthMaps({ index, cloud, key, cameraKeys: masked })).toEqual([])
  })
  it('keeps nothing after a rebuild, with other settings, or from an index without a key', () => {
    expect(reusableDepthMaps({ index, cloud: { ...cloud, createdAt: 6 }, key, cameraKeys: now })).toEqual([])
    expect(
      reusableDepthMaps({ index, cloud, key: depthMapsKey(depthRunShape({ quality: 'high' })), cameraKeys: now }),
    ).toEqual([])
    expect(reusableDepthMaps({ index: { ...index, mapsKey: undefined }, cloud, key, cameraKeys: now })).toEqual([])
  })
})
