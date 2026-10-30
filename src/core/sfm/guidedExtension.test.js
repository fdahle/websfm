import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { loadReconstructionWasm, guidedSearchClass } from './reconstruction.js'

import { guidedExtendTracks, trackDistanceThreshold, auditGuidedAdditions } from './guidedExtension.js'
import { keypointSetFrom } from './keypointSet.js'
import { tracksFrom, pointsOf } from './trackStore.testutil.js'

const K = { fx: 1000, fy: 1000, cx: 500, cy: 400 }
const I = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]
const cams = new Map([
  ['a', { R: I, t: [0, 0, 0], K }],
  ['b', { R: I, t: [-0.5, 0, 0], K }],
  ['c', { R: I, t: [0.5, 0, 0], K }],
])
const proj = (cam, p) => ({
  x: (K.fx * (p.x + cam.t[0])) / (p.z + cam.t[2]) + K.cx,
  y: (K.fy * (p.y + cam.t[1])) / (p.z + cam.t[2]) + K.cy,
})

let seed = 3
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const randomDesc = () => Uint8Array.from({ length: 128 }, () => Math.floor(rnd() * 120))
const jitter = (d, amt) => Uint8Array.from(d, (v) => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * amt))))

// World: 40 points; 0–19 are 3-view tracks (calibrate τ), 20–39 are 2-view (a, b).
function scene() {
  const images = new Map([
    ['a', { keypoints: [], desc: [] }],
    ['b', { keypoints: [], desc: [] }],
    ['c', { keypoints: [], desc: [] }],
  ])
  const add = (u, kp, d) => {
    const im = images.get(u)
    im.keypoints.push(kp)
    im.desc.push(d)
    return im.keypoints.length - 1
  }
  const points = [] // the fixture in literal form
  for (let i = 0; i < 40; i++) {
    const p = { x: (i % 8) / 4 - 1, y: Math.floor(i / 8) / 4 - 0.5, z: 5 }
    const d = randomDesc()
    const views = new Map()
    views.set('a', add('a', proj(cams.get('a'), p), jitter(d, 6)))
    views.set('b', add('b', proj(cams.get('b'), p), jitter(d, 6)))
    const kc = add('c', proj(cams.get('c'), p), jitter(d, 6)) // c always has the keypoint …
    if (i < 20) views.set('c', kc) // … but only the first 20 tracks know it
    points.push({ ...p, views })
  }
  const { tracks, ids } = tracksFrom(points, ['a', 'b', 'c'])
  const flat = new Map(
    [...images].map(([u, im]) => {
      const arr = new Uint8Array(im.desc.length * 128)
      im.desc.forEach((d, i) => arr.set(d, i * 128))
      return [u, arr]
    }),
  )
  const descOf = (img, k) => {
    const u = ids.uuid(img)
    return flat.has(u) && k < images.get(u).keypoints.length ? { arr: flat.get(u), off: k * 128 } : null
  }
  const keypointsAt = (img) => keypointSetFrom(images.get(ids.uuid(img))?.keypoints)
  const run = (opts = {}) => guidedExtendTracks({ tracks, ids, cameras: cams, keypointsAt, descOf, gatePx: 3, ...opts })
  return { points, tracks, ids, descOf, add, flat, run, live: () => pointsOf(tracks, ids) }
}

describe('trackDistanceThreshold', () => {
  it('is measured from multi-view tracks only', () => {
    const s = scene()
    const t = trackDistanceThreshold(s.tracks, s.descOf)
    expect(t).toBeGreaterThan(0)
    const twoView = tracksFrom(s.points.slice(20), ['a', 'b', 'c']).tracks
    expect(trackDistanceThreshold(twoView, s.descOf)).toBeNull() // 2-view only
  })
})

describe('guidedExtendTracks', () => {
  it('lifts 2-view points by finding their keypoint at the projection', () => {
    const s = scene()
    const stats = s.run()
    expect(stats.lifted).toBe(20)
    const live = s.live()
    expect(live.slice(20).every((p, j) => p.views.get('c') === 20 + j)).toBe(true)
  })

  it('refuses when an equally good distractor shares the window (ratio test)', () => {
    const s = scene()
    // A near-duplicate of point 25's descriptor, 1 px from its projection in c.
    const kp = proj(cams.get('c'), s.points[25])
    const twin = s.flat.get('c').slice(25 * 128, 26 * 128)
    const idx = s.add('c', { x: kp.x + 1, y: kp.y }, twin)
    const arr = new Uint8Array((idx + 1) * 128)
    arr.set(s.flat.get('c'))
    arr.set(twin, idx * 128)
    s.flat.set('c', arr)
    s.run()
    const live = s.live()
    expect(live[25].views.has('c')).toBe(false)
    expect(live[26].views.has('c')).toBe(true)
  })

  it('never takes a keypoint that already belongs to another point', () => {
    const s = scene()
    // Point 30's keypoint in c is claimed by another (unrelated, one-view) point.
    const q = s.tracks.addPoint(0, 0, 50)
    s.tracks.addView(q, s.ids.img('c'), 30)
    s.run()
    expect(s.live()[30].views.has('c')).toBe(false)
  })

  it('rejects a keypoint whose descriptor is far from the track', () => {
    const s = scene()
    s.flat.get('c').set(randomDesc(), 33 * 128) // replace the true descriptor with noise
    s.run()
    expect(s.live()[33].views.has('c')).toBe(false)
  })
})

describe('guidedExtendTracks in the crate', () => {
  // The search runs in the crate once its wasm is loaded (crates/reconstruction/src/
  // guided.rs) and in JS before: both must add the same observations in the same order,
  // or a run would depend on load order. A busy scene: six cameras, distractors next to
  // the true keypoints, exact descriptor ties, missing keypoints and a gate so small on
  // a wide image that the keypoint grid goes coarse (several gate cells per grid cell).
  it('adds what the JS search adds, in the same order', async () => {
    const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
    await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
    await loadReconstructionWasm()
    expect(guidedSearchClass()).not.toBeNull()
    let sd = 11
    // Its own generator: the shared one would shift the scenes of the tests after it.
    const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647
    const noise = () => Uint8Array.from({ length: 128 }, () => Math.floor(r() * 120))
    const jit = (d, amt) => Uint8Array.from(d, (v) => Math.max(0, Math.min(255, v + Math.round((r() - 0.5) * amt))))
    const Kw = { fx: 2000, fy: 2000, cx: 2000, cy: 1600 }
    const uuids = ['a', 'b', 'c', 'd', 'e', 'f']
    const cameras = new Map(uuids.map((u, i) => [u, { R: I, t: [0.3 * i - 0.75, 0.1 * (i % 2), 0], K: Kw }]))
    const pr = (cam, p) => ({
      x: (Kw.fx * (p.x + cam.t[0])) / (p.z + cam.t[2]) + Kw.cx,
      y: (Kw.fy * (p.y + cam.t[1])) / (p.z + cam.t[2]) + Kw.cy,
    })
    const kps = new Map(uuids.map((u) => [u, []]))
    const descs = new Map(uuids.map((u) => [u, []]))
    const put = (u, kp, d) => kps.get(u).push(kp) - 1 + (descs.get(u).push(d) && 0)
    const points = []
    for (let i = 0; i < 300; i++) {
      const p = { x: r() * 3 - 1.5, y: r() * 2.4 - 1.2, z: 4 + r() * 2 }
      const d = Uint8Array.from({ length: 128 }, () => Math.floor(r() * 200))
      const views = new Map()
      uuids.forEach((u, ci) => {
        const at = pr(cameras.get(u), p)
        const kp = { x: at.x + (r() - 0.5) * 0.8, y: at.y + (r() - 0.5) * 0.8 }
        const k = put(u, kp, jit(d, 10))
        // A distractor beside it, sometimes an exact twin (a tie the visiting order breaks).
        if (r() < 0.4)
          put(u, { x: kp.x + (r() - 0.5), y: kp.y + (r() - 0.5) }, r() < 0.5 ? descs.get(u)[k] : jit(d, 14))
        if (ci < 2 || (ci === 2 && i % 3 === 0)) views.set(u, k)
      })
      points.push({ ...p, views })
    }
    for (const u of uuids) {
      put(u, { x: 0, y: 0 }, noise()) // spread the bounds: a coarse grid
      put(u, { x: 4000, y: 3200 }, noise())
      put(u, { x: NaN, y: NaN }, noise()) // a missing keypoint
    }
    const flat = new Map(
      uuids.map((u) => {
        const arr = new Uint8Array(descs.get(u).length * 128)
        descs.get(u).forEach((d, i) => arr.set(d, i * 128))
        // One camera lacks its last descriptors: those keypoints are not candidates.
        return [u, u === 'f' ? arr.slice(0, arr.length - 128 * 40) : arr]
      }),
    )
    const runOnce = (native) => {
      const { tracks, ids } = tracksFrom(points, uuids)
      const descOf = (img, k) => {
        const a = flat.get(ids.uuid(img))
        return a && (k + 1) * 128 <= a.length ? { arr: a, off: k * 128 } : null
      }
      const adds = []
      const stats = guidedExtendTracks({
        tracks,
        ids,
        cameras,
        keypointsAt: (img) => keypointSetFrom(kps.get(ids.uuid(img))),
        descOf,
        descriptorsAt: (img) => flat.get(ids.uuid(img)) ?? null,
        native,
        gatePx: 1.2,
        onAdd: (p, img, kp) => adds.push([p, img, kp]),
      })
      return { stats, adds }
    }
    const js = runOnce(false)
    const crate = runOnce(true)
    expect(js.stats.added).toBeGreaterThan(100)
    expect(js.stats.windows).toBeGreaterThan(js.stats.proposals)
    expect(crate).toEqual(js)
  })
})

describe('auditGuidedAdditions', () => {
  it('separates surviving additions from the rest of the model', () => {
    const s = scene()
    const adds = []
    s.run({ onAdd: (p, img, kp) => adds.push({ uuid: s.ids.uuid(img), kp }) })
    expect(adds).toHaveLength(20)
    // Five extended points were filtered away.
    const live = s.live().slice(0, 35)
    const residualOf = (uuid, kp) => (uuid === 'c' && kp >= 20 ? 2 : 0.5)
    const a = auditGuidedAdditions(adds, (visit) =>
      live.forEach((pt) => pt.views.forEach((kp, uuid) => visit(uuid, kp, residualOf(uuid, kp)))),
    )
    expect(a).toMatchObject({ proposed: 20, survived: 15, medianPx: 2, restMedianPx: 0.5 })
  })
})
