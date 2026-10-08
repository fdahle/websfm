import { describe, it, expect } from 'vitest'
import { createTrackStore, makeImageIds } from './trackStore.js'

// Everything observable about a store: live points in order, each with position and
// views in order, and the whole keypoint → point index.
function snapshot(t, kpCounts) {
  const points = []
  t.forEachPoint((p) => {
    const views = []
    t.forEachView(p, (img, kp) => views.push([img, kp]))
    points.push({ p, xyz: [t.x(p), t.y(p), t.z(p)], views, n: t.viewCount(p) })
  })
  const index = kpCounts.map((n, img) => Array.from({ length: n }, (_, kp) => t.pointAt(img, kp)))
  return { live: t.liveCount(), ids: Array.from(t.liveIds()), points, index }
}

function rng(seed) {
  return () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
}

describe('TrackStore', () => {
  it('keeps views in insertion order, updates in place, re-appends after a removal (Map semantics)', () => {
    for (const impl of ['map', 'typed']) {
      const t = createTrackStore([5, 5, 5], { impl })
      const p = t.addPoint(1, 2, 3)
      t.addView(p, 2, 0); t.addView(p, 0, 1); t.addView(p, 1, 2)
      t.addView(p, 0, 3) // existing image: keypoint replaced in place
      const views = () => { const v = []; t.forEachView(p, (img, kp) => v.push([img, kp])); return v }
      expect(views()).toEqual([[2, 0], [0, 3], [1, 2]])
      expect(t.pointAt(0, 1)).toBe(-1) // the replaced keypoint is released
      expect(t.pointAt(0, 3)).toBe(p)
      t.removeView(p, 2)
      t.addView(p, 2, 4)
      expect(views()).toEqual([[0, 3], [1, 2], [2, 4]])
      expect(t.viewKp(p, 1)).toBe(2)
      expect(t.viewKp(p, 9)).toBe(-1)
    }
  })

  it('compacts to dense ids in order and rebuilds the index', () => {
    for (const impl of ['map', 'typed']) {
      const t = createTrackStore([4], { impl })
      const a = t.addPoint(0, 0, 0), b = t.addPoint(1, 1, 1), c = t.addPoint(2, 2, 2)
      t.addView(a, 0, 0); t.addView(b, 0, 1); t.addView(c, 0, 2)
      t.removePoint(b)
      expect(t.pointAt(0, 1)).toBe(-1)
      t.compact()
      expect(Array.from(t.liveIds())).toEqual([0, 1])
      expect([t.x(1), t.pointAt(0, 2)]).toEqual([2, 1])
    }
  })

  it('lets a visitor remove the view it is visiting', () => {
    for (const impl of ['map', 'typed']) {
      const t = createTrackStore([3, 3, 3], { impl })
      const p = t.addPoint(0, 0, 0)
      t.addView(p, 0, 0); t.addView(p, 1, 1); t.addView(p, 2, 2)
      const seen = []
      t.forEachView(p, (img) => { seen.push(img); if (img !== 1) t.removeView(p, img) })
      expect(seen).toEqual([0, 1, 2])
      expect(t.viewCount(p)).toBe(1)
      expect(t.pointAt(1, 1)).toBe(p)
    }
  })

  it('matches the Map reference under random churn (order, free list, index, compaction)', () => {
    const kpCounts = [40, 35, 50, 20, 45]
    const ref = createTrackStore(kpCounts, { impl: 'map' })
    const arena = createTrackStore(kpCounts, { impl: 'typed' })
    const next = rng(12345)
    const pick = (n) => Math.floor(next() * n)
    // Ids differ between the two only after a compaction; map them by position.
    for (let step = 0; step < 6000; step++) {
      const live = Array.from(ref.liveIds()), liveA = Array.from(arena.liveIds())
      const k = live.length ? pick(live.length) : -1
      const pr = live[k], pa = liveA[k]
      const r = next()
      if (r < 0.2 || !live.length) {
        const xyz = [next(), next(), next()]
        ref.addPoint(...xyz); arena.addPoint(...xyz)
      } else if (r < 0.62) {
        const img = pick(kpCounts.length), kp = pick(kpCounts[img])
        ref.addView(pr, img, kp); arena.addView(pa, img, kp)
      } else if (r < 0.8) {
        const img = pick(kpCounts.length)
        ref.removeView(pr, img); arena.removeView(pa, img)
      } else if (r < 0.9) {
        ref.removePoint(pr); arena.removePoint(pa)
      } else if (r < 0.95) {
        const xyz = [next(), next(), next()]
        ref.setPosition(pr, ...xyz); arena.setPosition(pa, ...xyz)
      } else if (r < 0.975) {
        ref.reindex(); arena.reindex()
      } else {
        ref.compact(); arena.compact()
      }
      const a = snapshot(ref, kpCounts), b = snapshot(arena, kpCounts)
      // Point ids are positions in creation order for both until a compaction, and
      // dense for both after one, so they must agree throughout.
      expect(b, `step ${step}`).toEqual(a)
    }
  }, 60_000)

  it('maps uuids to image indices, first occurrence winning', () => {
    const ids = makeImageIds(['a', 'b', 'a'])
    expect([ids.img('a'), ids.img('b'), ids.img('zz'), ids.uuid(1), ids.count]).toEqual([0, 1, -1, 'b', 3])
  })
})
