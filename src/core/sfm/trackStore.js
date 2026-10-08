// The SfM worker's tracks: 3D points and the keypoints that observe them (pure).
//
// A point is a dense integer id `p`, an image is its dense index `img` in the run's
// image list, a keypoint is its index `kp` in that image. Two implementations share
// this API: 'map' (one Map per point and per image — the old representation, kept as
// the reference the arena is tested against) and 'typed' (the arena below). See
// docs/planning/plan-sfm-compact-memory.md (TODO ▸ MEM) for why.
//
// Semantics the solver relies on (they are the old `{views: Map}` + `viewIndex`
// semantics, made explicit):
// - ORDER. Live points iterate in creation order (`forEachPoint`, `liveIds`), and a
//   point's views in the order they were added (`forEachView`). Bundle adjustment's
//   observation order, and so its summation order, follows both. `addView` on an image
//   the point already observes updates the keypoint in place; removing a view and
//   adding it again moves it to the end — exactly a Map's behaviour.
// - IDS ARE STABLE until `compact()`, which renumbers the live points 0..n−1 in order.
//   Positions are updated in place (`setPosition`), so a bundle adjustment no longer
//   replaces every point.
// - THE INDEX (`pointAt`) is maintained incrementally: an added view claims its
//   keypoint (the last claim wins, as a Map's `set` did), a removed view or point
//   releases only the keypoints it still holds. `reindex()` rebuilds it from the live
//   points in order — where the old code rebuilt `viewIndex`, so that when two points
//   ever claim one keypoint, the later point in order wins exactly as before.

const EMPTY = -1

class MapTrackStore {
  constructor(keypointCounts) {
    this.nImages = keypointCounts.length
    this.pts = []      // p → { x, y, z, views: Map<img, kp> } | null
    this.index = Array.from({ length: this.nImages }, () => new Map()) // img → Map<kp, p>
    this.nLive = 0
  }
  addPoint(x, y, z) { this.pts.push({ x, y, z, views: new Map() }); this.nLive++; return this.pts.length - 1 }
  isLive(p) { return !!this.pts[p] }
  removePoint(p) {
    const pt = this.pts[p]
    for (const [img, kp] of pt.views) if (this.index[img].get(kp) === p) this.index[img].delete(kp)
    this.pts[p] = null
    this.nLive--
  }
  x(p) { return this.pts[p].x }
  y(p) { return this.pts[p].y }
  z(p) { return this.pts[p].z }
  setPosition(p, x, y, z) { const pt = this.pts[p]; pt.x = x; pt.y = y; pt.z = z }
  addView(p, img, kp) {
    const views = this.pts[p].views
    const old = views.get(img)
    if (old !== undefined && old !== kp && this.index[img].get(old) === p) this.index[img].delete(old)
    views.set(img, kp)
    this.index[img].set(kp, p)
  }
  removeView(p, img) {
    const views = this.pts[p].views
    const kp = views.get(img)
    if (kp === undefined) return
    views.delete(img)
    if (this.index[img].get(kp) === p) this.index[img].delete(kp)
  }
  viewKp(p, img) { return this.pts[p].views.get(img) ?? EMPTY }
  viewCount(p) { return this.pts[p].views.size }
  forEachView(p, fn) { for (const [img, kp] of this.pts[p].views) fn(img, kp) }
  someView(p, fn) { for (const [img, kp] of this.pts[p].views) if (fn(img, kp)) return true; return false }
  pointAt(img, kp) { return this.index[img]?.get(kp) ?? EMPTY }
  forEachPoint(fn) { const pts = this.pts; for (let p = 0; p < pts.length; p++) if (pts[p]) fn(p) }
  liveCount() { return this.nLive }
  liveIds() {
    const out = new Int32Array(this.nLive)
    let i = 0
    this.forEachPoint((p) => { out[i++] = p })
    return out
  }
  reindex() {
    for (const m of this.index) m.clear()
    this.forEachPoint((p) => { for (const [img, kp] of this.pts[p].views) this.index[img].set(kp, p) })
  }
  compact() {
    this.pts = this.pts.filter(Boolean)
    this.reindex()
  }
}

// The arena. Per point: position (Float64 ×3) and the head/tail/count of a singly
// linked list of observations, appended at the tail so insertion order holds. Per
// observation: image, keypoint, next (Int32 ×3), recycled through a free list. Per
// image: `trackOf`, one Int32 per keypoint (−1 = none), allocated on first use.
// ~12 B per observation + 4 B per keypoint + 37 B per point, against the hundreds of
// bytes a Map entry, a Map per point and an index Map per image cost.
class TypedTrackStore {
  constructor(keypointCounts) {
    this.kpCounts = Int32Array.from(keypointCounts)
    this.trackOf = new Array(keypointCounts.length).fill(null)
    this.cap = 0; this.nPts = 0; this.nLive = 0
    this.pos = new Float64Array(0)
    this.head = new Int32Array(0); this.tail = new Int32Array(0); this.cnt = new Int32Array(0)
    this.live = new Uint8Array(0)
    this.ocap = 0; this.nObs = 0; this.freeObs = EMPTY
    this.obsImg = new Int32Array(0); this.obsKp = new Int32Array(0); this.obsNext = new Int32Array(0)
  }

  growPoints() {
    const cap = Math.max(1024, this.cap * 2)
    const grow = (a, T, k = 1) => { const b = new T(cap * k); b.set(a); return b }
    this.pos = grow(this.pos, Float64Array, 3)
    this.head = grow(this.head, Int32Array); this.tail = grow(this.tail, Int32Array); this.cnt = grow(this.cnt, Int32Array)
    this.live = grow(this.live, Uint8Array)
    this.cap = cap
  }
  allocObs() {
    if (this.freeObs !== EMPTY) { const o = this.freeObs; this.freeObs = this.obsNext[o]; return o }
    if (this.nObs === this.ocap) {
      const ocap = Math.max(4096, this.ocap * 2)
      const grow = (a) => { const b = new Int32Array(ocap); b.set(a); return b }
      this.obsImg = grow(this.obsImg); this.obsKp = grow(this.obsKp); this.obsNext = grow(this.obsNext)
      this.ocap = ocap
    }
    return this.nObs++
  }
  freeOb(o) { this.obsNext[o] = this.freeObs; this.freeObs = o }
  claim(img, kp, p) {
    let t = this.trackOf[img]
    if (!t) { t = this.trackOf[img] = new Int32Array(this.kpCounts[img]).fill(EMPTY) }
    t[kp] = p
  }
  release(img, kp, p) { const t = this.trackOf[img]; if (t && t[kp] === p) t[kp] = EMPTY }

  addPoint(x, y, z) {
    if (this.nPts === this.cap) this.growPoints()
    const p = this.nPts++
    this.pos[3 * p] = x; this.pos[3 * p + 1] = y; this.pos[3 * p + 2] = z
    this.head[p] = EMPTY; this.tail[p] = EMPTY; this.cnt[p] = 0
    this.live[p] = 1
    this.nLive++
    return p
  }
  isLive(p) { return p >= 0 && p < this.nPts && this.live[p] === 1 }
  removePoint(p) {
    for (let o = this.head[p]; o !== EMPTY;) {
      const next = this.obsNext[o]
      this.release(this.obsImg[o], this.obsKp[o], p)
      this.freeOb(o)
      o = next
    }
    this.head[p] = EMPTY; this.tail[p] = EMPTY; this.cnt[p] = 0
    this.live[p] = 0
    this.nLive--
  }
  x(p) { return this.pos[3 * p] }
  y(p) { return this.pos[3 * p + 1] }
  z(p) { return this.pos[3 * p + 2] }
  setPosition(p, x, y, z) { this.pos[3 * p] = x; this.pos[3 * p + 1] = y; this.pos[3 * p + 2] = z }

  addView(p, img, kp) {
    for (let o = this.head[p]; o !== EMPTY; o = this.obsNext[o]) {
      if (this.obsImg[o] !== img) continue
      const old = this.obsKp[o]
      if (old !== kp) { this.release(img, old, p); this.obsKp[o] = kp }
      this.claim(img, kp, p)
      return
    }
    const o = this.allocObs()
    this.obsImg[o] = img; this.obsKp[o] = kp; this.obsNext[o] = EMPTY
    if (this.tail[p] === EMPTY) this.head[p] = o
    else this.obsNext[this.tail[p]] = o
    this.tail[p] = o
    this.cnt[p]++
    this.claim(img, kp, p)
  }
  removeView(p, img) {
    let prev = EMPTY
    for (let o = this.head[p]; o !== EMPTY; prev = o, o = this.obsNext[o]) {
      if (this.obsImg[o] !== img) continue
      const next = this.obsNext[o]
      if (prev === EMPTY) this.head[p] = next
      else this.obsNext[prev] = next
      if (this.tail[p] === o) this.tail[p] = prev
      this.cnt[p]--
      this.release(img, this.obsKp[o], p)
      this.freeOb(o)
      return
    }
  }
  viewKp(p, img) {
    for (let o = this.head[p]; o !== EMPTY; o = this.obsNext[o]) if (this.obsImg[o] === img) return this.obsKp[o]
    return EMPTY
  }
  viewCount(p) { return this.cnt[p] }
  forEachView(p, fn) {
    for (let o = this.head[p]; o !== EMPTY;) {
      // Read `next` first, so `fn` may remove the view it is visiting.
      const next = this.obsNext[o]
      fn(this.obsImg[o], this.obsKp[o])
      o = next
    }
  }
  someView(p, fn) {
    for (let o = this.head[p]; o !== EMPTY; o = this.obsNext[o]) if (fn(this.obsImg[o], this.obsKp[o])) return true
    return false
  }
  pointAt(img, kp) { const t = this.trackOf[img]; return t ? t[kp] ?? EMPTY : EMPTY }
  forEachPoint(fn) { const live = this.live; for (let p = 0; p < this.nPts; p++) if (live[p]) fn(p) }
  liveCount() { return this.nLive }
  liveIds() {
    const out = new Int32Array(this.nLive)
    let i = 0
    for (let p = 0; p < this.nPts; p++) if (this.live[p]) out[i++] = p
    return out
  }
  reindex() {
    for (const t of this.trackOf) if (t) t.fill(EMPTY)
    for (let p = 0; p < this.nPts; p++) {
      if (!this.live[p]) continue
      for (let o = this.head[p]; o !== EMPTY; o = this.obsNext[o]) this.claim(this.obsImg[o], this.obsKp[o], p)
    }
  }
  // Renumber the live points 0..n−1 in order, and pack their observations in order
  // (which also empties the free list). Ids held by callers are invalid afterwards.
  compact() {
    let q = 0, oq = 0
    const obsImg = new Int32Array(Math.max(4096, this.nObs)), obsKp = new Int32Array(obsImg.length)
    const obsNext = new Int32Array(obsImg.length)
    for (let p = 0; p < this.nPts; p++) {
      if (!this.live[p]) continue
      this.pos[3 * q] = this.pos[3 * p]; this.pos[3 * q + 1] = this.pos[3 * p + 1]; this.pos[3 * q + 2] = this.pos[3 * p + 2]
      // Read p's list head before writing q's: q === p for every point before the
      // first removed one.
      const n = this.cnt[p], h = this.head[p]
      this.head[q] = n ? oq : EMPTY
      for (let o = h; o !== EMPTY; o = this.obsNext[o]) {
        obsImg[oq] = this.obsImg[o]; obsKp[oq] = this.obsKp[o]; obsNext[oq] = oq + 1; oq++
      }
      if (n) obsNext[oq - 1] = EMPTY
      this.tail[q] = n ? oq - 1 : EMPTY
      this.cnt[q] = n
      this.live[q] = 1
      q++
    }
    this.live.fill(0, q, this.nPts)
    this.nPts = q
    this.obsImg = obsImg; this.obsKp = obsKp; this.obsNext = obsNext
    this.ocap = obsImg.length; this.nObs = oq; this.freeObs = EMPTY
    this.reindex()
  }
}

/**
 * @param {ArrayLike<number>} keypointCounts  per image index: its number of keypoints
 * @param {{impl?: 'typed' | 'map'}} [opts]   'map' is the reference implementation
 */
export function createTrackStore(keypointCounts, { impl = 'typed' } = {}) {
  return impl === 'map' ? new MapTrackStore(keypointCounts) : new TypedTrackStore(keypointCounts)
}

/**
 * uuid ↔ dense image index for one run: `img(uuid)` (−1 when unknown) and `uuid(img)`.
 * The first occurrence of a duplicated uuid wins, as the old `images.find` lookup did.
 */
export function makeImageIds(uuids) {
  const byUuid = new Map()
  uuids.forEach((u, i) => { if (!byUuid.has(u)) byUuid.set(u, i) })
  return {
    count: uuids.length,
    img: (uuid) => byUuid.get(uuid) ?? EMPTY,
    uuid: (img) => uuids[img],
  }
}
