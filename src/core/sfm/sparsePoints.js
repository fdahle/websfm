// A sparse cloud's points as columns (TODO ▸ SC-5). One instance holds what used to
// be one { x, y, z, color, views, viewsPx } object per point (~310 B each on the JS
// heap, in both the worker and the main thread):
//
//   pos        Float64Array(3n)  xyz
//   col        Uint8Array(3n) | null, colorMask Uint8Array(n) | null — a point whose
//              observing keypoints carried no colour has mask 0 (null mask: all present)
//   viewUuids  string[]          the cameras the tracks name, by index
//   vcount     Uint32Array(n)    views per point; vstart (n + 1) is its prefix sum
//   vcam, vkp  Uint32Array(Σ)    per view: camera index into viewUuids, keypoint index
//   vx, vy     Float32Array(Σ) | null  per view: the BA-frame (pinhole) pixel, NaN when
//              the view has none (imports without pixels)
//
// Point i's views are slots vstart[i] … vstart[i+1]−1. Sparse clouds are immutable
// once reconstructed: tools that change points build a new instance (`select`,
// `concat`, `withPositions`), so the arrays can be shared, transferred and persisted
// as they are. The one in-place write is a rigid transform of `pos` on a cloud the
// caller just received (rotateReconstruction's inPlace path).

export class SparsePoints {
  constructor({ pos, col = null, colorMask = null, viewUuids = [], vcount, vcam, vkp, vx = null, vy = null }) {
    this.pos = pos
    this.col = col
    this.colorMask = col ? colorMask : null
    this.viewUuids = viewUuids
    this.vcount = vcount
    this.vcam = vcam
    this.vkp = vkp
    this.vx = vx
    this.vy = vy
    const n = vcount.length
    const vstart = new Uint32Array(n + 1)
    for (let i = 0; i < n; i++) vstart[i + 1] = vstart[i] + vcount[i]
    this.vstart = vstart
    this._cameraIndex = null
  }

  get length() {
    return this.vcount.length
  }
  get count() {
    return this.vcount.length
  }
  get viewTotal() {
    return this.vstart[this.vcount.length]
  }
  get hasColor() {
    return !!this.col
  }

  /** Whether any view carries a BA-frame pixel (a reconstructed cloud; not a legacy one). */
  get hasPixels() {
    const { vx } = this
    if (!vx) return false
    for (let k = 0, n = this.viewTotal; k < n; k++) if (Number.isFinite(vx[k])) return true
    return false
  }

  x(i) {
    return this.pos[3 * i]
  }
  y(i) {
    return this.pos[3 * i + 1]
  }
  z(i) {
    return this.pos[3 * i + 2]
  }
  xyz(i) {
    return [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]]
  }

  hasColorAt(i) {
    return !!this.col && (!this.colorMask || this.colorMask[i] === 1)
  }
  /** [r, g, b], or null when the point has no colour. Allocates: not for hot loops. */
  colorAt(i) {
    if (!this.hasColorAt(i)) return null
    const c = this.col
    return [c[3 * i], c[3 * i + 1], c[3 * i + 2]]
  }

  viewCount(i) {
    return this.vcount[i]
  }
  /** Views carrying a finite pixel. */
  pixelCount(i) {
    const { vx } = this
    if (!vx) return 0
    let n = 0
    for (let k = this.vstart[i], end = this.vstart[i + 1]; k < end; k++) if (Number.isFinite(vx[k])) n++
    return n
  }

  /** fn(uuid, kp, px, py, slot) per view of point i, in track order; px/py NaN when absent. */
  forEachView(i, fn) {
    const { viewUuids, vcam, vkp, vx, vy } = this
    for (let k = this.vstart[i], end = this.vstart[i + 1]; k < end; k++) {
      fn(viewUuids[vcam[k]], vkp[k], vx ? vx[k] : NaN, vy ? vy[k] : NaN, k)
    }
  }

  /** fn(uuid, px, py, slot) per view of point i that has a finite pixel. */
  forEachPixel(i, fn) {
    const { viewUuids, vcam, vx, vy } = this
    if (!vx) return
    for (let k = this.vstart[i], end = this.vstart[i + 1]; k < end; k++) {
      if (Number.isFinite(vx[k])) fn(viewUuids[vcam[k]], vx[k], vy[k], k)
    }
  }

  /** The slot of point i's view in `uuid`, or −1. Linear in the track (a few views). */
  slotOf(i, uuid) {
    const { viewUuids, vcam } = this
    for (let k = this.vstart[i], end = this.vstart[i + 1]; k < end; k++) if (viewUuids[vcam[k]] === uuid) return k
    return -1
  }
  kpOf(i, uuid) {
    const k = this.slotOf(i, uuid)
    return k < 0 ? undefined : this.vkp[k]
  }
  pixelOf(i, uuid) {
    const k = this.slotOf(i, uuid)
    return k >= 0 && this.vx && Number.isFinite(this.vx[k]) ? [this.vx[k], this.vy[k]] : undefined
  }

  /** Per camera, the views that name it: CSR over camera indices, built once. */
  cameraIndex() {
    if (this._cameraIndex) return this._cameraIndex
    const nCam = this.viewUuids.length,
      total = this.viewTotal,
      { vcam, vstart } = this
    const start = new Uint32Array(nCam + 1)
    for (let k = 0; k < total; k++) start[vcam[k] + 1]++
    for (let c = 0; c < nCam; c++) start[c + 1] += start[c]
    const fill = start.slice(0, nCam)
    const point = new Uint32Array(total),
      slot = new Uint32Array(total)
    for (let i = 0, n = this.length; i < n; i++) {
      for (let k = vstart[i]; k < vstart[i + 1]; k++) {
        const at = fill[vcam[k]]++
        point[at] = i
        slot[at] = k
      }
    }
    const byUuid = new Map(this.viewUuids.map((u, c) => [u, c]))
    this._cameraIndex = { start, point, slot, byUuid }
    return this._cameraIndex
  }

  /** fn(pointIndex, slot) for every point `uuid` observes, in point order. */
  forEachPointOf(uuid, fn) {
    const { start, point, slot, byUuid } = this.cameraIndex()
    const c = byUuid.get(uuid)
    if (c === undefined) return
    for (let at = start[c]; at < start[c + 1]; at++) fn(point[at], slot[at])
  }

  /** Reiterable xyz, one scratch record per iterator (pointView.ts's contract). */
  *[Symbol.iterator]() {
    const p = { x: 0, y: 0, z: 0 },
      { pos } = this
    for (let i = 0, n = this.length; i < n; i++) {
      p.x = pos[3 * i]
      p.y = pos[3 * i + 1]
      p.z = pos[3 * i + 2]
      yield p
    }
  }

  /**
   * The points at `indices` (ascending or not; each kept once per mention), as a new
   * cloud. `pos` (3 × indices.length) replaces their positions; `pixel(uuid, px, py,
   * pointIndex)` → [x, y] | null may move a kept view's pixel.
   */
  select(indices, { pos = null, pixel = null } = {}) {
    const m = indices.length
    const outPos = pos ?? new Float64Array(3 * m)
    const col = this.col ? new Uint8Array(3 * m) : null
    const colorMask = this.col && this.colorMask ? new Uint8Array(m) : null
    const vcount = new Uint32Array(m)
    let total = 0
    for (let j = 0; j < m; j++) {
      vcount[j] = this.vcount[indices[j]]
      total += vcount[j]
    }
    const vcam = new Uint32Array(total),
      vkp = new Uint32Array(total)
    const vx = this.vx ? new Float32Array(total) : null,
      vy = this.vy ? new Float32Array(total) : null
    let o = 0
    for (let j = 0; j < m; j++) {
      const i = indices[j]
      if (!pos) {
        outPos[3 * j] = this.pos[3 * i]
        outPos[3 * j + 1] = this.pos[3 * i + 1]
        outPos[3 * j + 2] = this.pos[3 * i + 2]
      }
      if (col) {
        col[3 * j] = this.col[3 * i]
        col[3 * j + 1] = this.col[3 * i + 1]
        col[3 * j + 2] = this.col[3 * i + 2]
      }
      if (colorMask) colorMask[j] = this.colorMask[i]
      for (let k = this.vstart[i]; k < this.vstart[i + 1]; k++, o++) {
        vcam[o] = this.vcam[k]
        vkp[o] = this.vkp[k]
        if (vx) {
          vx[o] = this.vx[k]
          vy[o] = this.vy[k]
          if (pixel && Number.isFinite(vx[o])) {
            const q = pixel(this.viewUuids[this.vcam[k]], vx[o], vy[o], i)
            if (q) {
              vx[o] = q[0]
              vy[o] = q[1]
            }
          }
        }
      }
    }
    return new SparsePoints({ pos: outPos, col, colorMask, viewUuids: this.viewUuids, vcount, vcam, vkp, vx, vy })
  }

  /** Indices of the points `keep(i)` accepts. */
  indicesWhere(keep) {
    const out = []
    for (let i = 0, n = this.length; i < n; i++) if (keep(i)) out.push(i)
    return Uint32Array.from(out)
  }

  /** The same tracks and colours at new positions (3n). */
  withPositions(pos) {
    return new SparsePoints({ ...this.columns(), pos })
  }

  /**
   * The flat { count, pos, col? } shape the cloud writers and 3D Tiles take, every
   * array a copy (callers transfer it). A point without colour gets `grey`.
   */
  flatCopy(grey = 200) {
    const n = this.length,
      pos = this.pos.slice(0, 3 * n)
    if (!this.col) return { count: n, pos }
    const col = this.col.slice(0, 3 * n)
    if (this.colorMask) for (let i = 0; i < n; i++) if (!this.colorMask[i]) col.fill(grey, 3 * i, 3 * i + 3)
    return { count: n, pos, col }
  }

  /** The constructor arguments: what persistence and transport carry. */
  columns() {
    const { pos, col, colorMask, viewUuids, vcount, vcam, vkp, vx, vy } = this
    return { pos, col, colorMask, viewUuids, vcount, vcam, vkp, vx, vy }
  }

  /** Clouds one after the other; camera indices are re-keyed onto one uuid list. */
  static concat(clouds) {
    const parts = clouds.filter((c) => c && c.length)
    if (parts.length === 1) return parts[0]
    if (!parts.length) return SparsePoints.empty()
    const uuids = [],
      index = new Map()
    const n = parts.reduce((s, c) => s + c.length, 0),
      total = parts.reduce((s, c) => s + c.viewTotal, 0)
    const anyColor = parts.some((c) => c.col),
      anyPx = parts.some((c) => c.vx)
    const pos = new Float64Array(3 * n),
      vcount = new Uint32Array(n)
    const col = anyColor ? new Uint8Array(3 * n) : null,
      colorMask = anyColor ? new Uint8Array(n) : null
    const vcam = new Uint32Array(total),
      vkp = new Uint32Array(total)
    const vx = anyPx ? new Float32Array(total).fill(NaN) : null,
      vy = anyPx ? new Float32Array(total).fill(NaN) : null
    let p0 = 0,
      v0 = 0
    for (const c of parts) {
      const remap = c.viewUuids.map((u) => {
        let ci = index.get(u)
        if (ci === undefined) {
          ci = uuids.length
          index.set(u, ci)
          uuids.push(u)
        }
        return ci
      })
      pos.set(c.pos.subarray(0, 3 * c.length), 3 * p0)
      vcount.set(c.vcount, p0)
      if (col && c.col) {
        col.set(c.col.subarray(0, 3 * c.length), 3 * p0)
        for (let i = 0; i < c.length; i++) colorMask[p0 + i] = c.hasColorAt(i) ? 1 : 0
      }
      for (let k = 0; k < c.viewTotal; k++) vcam[v0 + k] = remap[c.vcam[k]]
      vkp.set(c.vkp.subarray(0, c.viewTotal), v0)
      if (vx && c.vx) {
        vx.set(c.vx.subarray(0, c.viewTotal), v0)
        vy.set(c.vy.subarray(0, c.viewTotal), v0)
      }
      p0 += c.length
      v0 += c.viewTotal
    }
    return new SparsePoints({ pos, col, colorMask, viewUuids: uuids, vcount, vcam, vkp, vx, vy })
  }

  static empty() {
    return new SparsePoints({
      pos: new Float64Array(0),
      vcount: new Uint32Array(0),
      vcam: new Uint32Array(0),
      vkp: new Uint32Array(0),
    })
  }

  /**
   * From point records { x, y, z, color?, views?, viewsPx? } — imports and tests.
   * `views`: a Map uuid → kp or [[uuid, kp(, px, py)], …]; `viewsPx`: Map uuid → [x, y].
   * A view only in viewsPx has no keypoint (kp 0); pixels absent everywhere ⇒ vx null.
   */
  static fromRecords(records) {
    const n = records.length
    const pos = new Float64Array(3 * n),
      vcount = new Uint32Array(n)
    const hasColor = records.some((p) => p.color)
    const col = hasColor ? new Uint8Array(3 * n) : null,
      colorMask = hasColor ? new Uint8Array(n) : null
    const views = records.map((p) => {
      const out = []
      for (const v of p.views ?? []) {
        const px = p.viewsPx?.get?.(v[0]) ?? (v.length >= 4 ? [v[2], v[3]] : null)
        out.push([v[0], v[1], px])
      }
      if (p.viewsPx) for (const [u, px] of p.viewsPx) if (!out.some((v) => v[0] === u)) out.push([u, 0, px])
      return out
    })
    const total = views.reduce((s, v) => s + v.length, 0)
    const anyPx = views.some((v) => v.some((x) => x[2]))
    const vcam = new Uint32Array(total),
      vkp = new Uint32Array(total)
    const vx = anyPx ? new Float32Array(total).fill(NaN) : null,
      vy = anyPx ? new Float32Array(total).fill(NaN) : null
    const uuids = [],
      index = new Map()
    let k = 0
    for (let i = 0; i < n; i++) {
      const p = records[i]
      pos[3 * i] = p.x
      pos[3 * i + 1] = p.y
      pos[3 * i + 2] = p.z
      if (col && p.color) {
        col[3 * i] = p.color[0]
        col[3 * i + 1] = p.color[1]
        col[3 * i + 2] = p.color[2]
        colorMask[i] = 1
      }
      vcount[i] = views[i].length
      for (const [u, kp, px] of views[i]) {
        let ci = index.get(u)
        if (ci === undefined) {
          ci = uuids.length
          index.set(u, ci)
          uuids.push(u)
        }
        vcam[k] = ci
        vkp[k] = kp
        if (vx && px) {
          vx[k] = px[0]
          vy[k] = px[1]
        }
        k++
      }
    }
    return new SparsePoints({ pos, col, colorMask, viewUuids: uuids, vcount, vcam, vkp, vx, vy })
  }
}

export const isSparsePoints = (p) => p instanceof SparsePoints
