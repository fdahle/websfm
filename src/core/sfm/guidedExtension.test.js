import { describe, it, expect } from 'vitest'

import { guidedExtendTracks, trackDistanceThreshold, auditGuidedAdditions } from './guidedExtension.js'

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
const cams = new Map([
  ['a', { R: I, t: [0, 0, 0], K }],
  ['b', { R: I, t: [-0.5, 0, 0], K }],
  ['c', { R: I, t: [0.5, 0, 0], K }],
])
const proj = (cam, p) => ({ x: K.fx * (p.x + cam.t[0]) / (p.z + cam.t[2]) + K.cx, y: K.fy * (p.y + cam.t[1]) / (p.z + cam.t[2]) + K.cy })

let seed = 3
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const randomDesc = () => Uint8Array.from({ length: 128 }, () => Math.floor(rnd() * 120))
const jitter = (d, amt) => Uint8Array.from(d, (v) => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * amt))))

// World: 40 points; 0–19 are 3-view tracks (calibrate τ), 20–39 are 2-view (a, b).
function scene() {
  const images = new Map([['a', { keypoints: [], desc: [] }], ['b', { keypoints: [], desc: [] }], ['c', { keypoints: [], desc: [] }]])
  const add = (u, kp, d) => { const im = images.get(u); im.keypoints.push(kp); im.desc.push(d); return im.keypoints.length - 1 }
  const points3d = []
  for (let i = 0; i < 40; i++) {
    const p = { x: (i % 8) / 4 - 1, y: Math.floor(i / 8) / 4 - 0.5, z: 5 }
    const d = randomDesc()
    const views = new Map()
    views.set('a', add('a', proj(cams.get('a'), p), jitter(d, 6)))
    views.set('b', add('b', proj(cams.get('b'), p), jitter(d, 6)))
    const kc = add('c', proj(cams.get('c'), p), jitter(d, 6)) // c always has the keypoint …
    if (i < 20) views.set('c', kc) // … but only the first 20 tracks know it
    points3d.push({ ...p, views })
  }
  const viewIndex = new Map()
  const addView = (pt, u, k) => {
    pt.views.set(u, k)
    if (!viewIndex.has(u)) viewIndex.set(u, new Map())
    viewIndex.get(u).set(k, pt)
  }
  for (const pt of points3d) for (const [u, k] of pt.views) {
    if (!viewIndex.has(u)) viewIndex.set(u, new Map())
    viewIndex.get(u).set(k, pt)
  }
  const flat = new Map([...images].map(([u, im]) => {
    const arr = new Uint8Array(im.desc.length * 128)
    im.desc.forEach((d, i) => arr.set(d, i * 128))
    return [u, arr]
  }))
  const descOf = (u, k) => (flat.has(u) && k < images.get(u).keypoints.length ? { arr: flat.get(u), off: k * 128 } : null)
  return { images, points3d, viewIndex, addView, descOf, imageOf: (u) => images.get(u), add, flat }
}

describe('trackDistanceThreshold', () => {
  it('is measured from multi-view tracks only', () => {
    const s = scene()
    const t = trackDistanceThreshold(s.points3d, s.descOf)
    expect(t).toBeGreaterThan(0)
    expect(trackDistanceThreshold(s.points3d.slice(20), s.descOf)).toBeNull() // 2-view only
  })
})

describe('guidedExtendTracks', () => {
  it('lifts 2-view points by finding their keypoint at the projection', () => {
    const s = scene()
    const stats = guidedExtendTracks({ points3d: s.points3d, cameras: cams, imageOf: s.imageOf, descOf: s.descOf,
      viewIndex: s.viewIndex, addView: s.addView, gatePx: 3 })
    expect(stats.lifted).toBe(20)
    expect(s.points3d.slice(20).every((p) => p.views.get('c') === s.points3d.indexOf(p))).toBe(true)
  })

  it('refuses when an equally good distractor shares the window (ratio test)', () => {
    const s = scene()
    // A near-duplicate of point 25's descriptor, 1 px from its projection in c.
    const p = s.points3d[25]
    const kp = proj(cams.get('c'), p)
    const twin = s.flat.get('c').slice(25 * 128, 26 * 128)
    const idx = s.add('c', { x: kp.x + 1, y: kp.y }, twin)
    const arr = new Uint8Array((idx + 1) * 128); arr.set(s.flat.get('c')); arr.set(twin, idx * 128); s.flat.set('c', arr)
    guidedExtendTracks({ points3d: s.points3d, cameras: cams, imageOf: s.imageOf, descOf: s.descOf,
      viewIndex: s.viewIndex, addView: s.addView, gatePx: 3 })
    expect(p.views.has('c')).toBe(false)
    expect(s.points3d[26].views.has('c')).toBe(true)
  })

  it('never takes a keypoint that already belongs to another point', () => {
    const s = scene()
    // Point 30's keypoint in c is claimed by point 0's track (an unrelated point).
    s.viewIndex.get('c').set(30, s.points3d[0])
    guidedExtendTracks({ points3d: s.points3d, cameras: cams, imageOf: s.imageOf, descOf: s.descOf,
      viewIndex: s.viewIndex, addView: s.addView, gatePx: 3 })
    expect(s.points3d[30].views.has('c')).toBe(false)
  })

  it('rejects a keypoint whose descriptor is far from the track', () => {
    const s = scene()
    const off = 33 * 128
    s.flat.get('c').set(randomDesc(), off) // replace the true descriptor with noise
    guidedExtendTracks({ points3d: s.points3d, cameras: cams, imageOf: s.imageOf, descOf: s.descOf,
      viewIndex: s.viewIndex, addView: s.addView, gatePx: 3 })
    expect(s.points3d[33].views.has('c')).toBe(false)
  })
})

describe('auditGuidedAdditions', () => {
  it('separates surviving additions from the rest of the model', () => {
    const s = scene()
    const adds = []
    guidedExtendTracks({ points3d: s.points3d, cameras: cams, imageOf: s.imageOf, descOf: s.descOf,
      viewIndex: s.viewIndex, addView: s.addView, gatePx: 3, onAdd: (pt, uuid, kp) => adds.push({ uuid, kp }) })
    expect(adds).toHaveLength(20)
    // Five extended points were filtered away; the rest come back as fresh objects (BA).
    const live = s.points3d.slice(0, 35).map((p) => ({ ...p, views: new Map(p.views) }))
    const residualOf = (pt, uuid, kp) => (uuid === 'c' && kp >= 20 ? 2 : 0.5)
    const a = auditGuidedAdditions(adds, live, residualOf)
    expect(a).toMatchObject({ proposed: 20, survived: 15, medianPx: 2, restMedianPx: 0.5 })
  })
})
