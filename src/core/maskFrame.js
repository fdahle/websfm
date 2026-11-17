// Auto Mask ▸ Frame: where the photograph on a film scan begins, per side. A scan holds
// the photograph inside a dark film border (the frame, with its fiducials, data strip,
// dials), often inside a bright band of scanner bed; masking the frame keeps its marks,
// identical on every frame, out of the tie points. A fixed border fits badly: each scan
// sits a little differently in the scanner. Pure: a grey raster in, margins out.
//
// Per side, the profile running inward is the median brightness across the middle of
// the scan (a bright data card or dial on the frame stays out of a median), and the
// frame is the dark run met walking in from the edge: past any bright scanner bed, into
// the dark, and out where the profile rises to the photograph again.

import { FRAME_MASK_TUNING as T } from './tuning.js'

// The thresholds are FRAME_MASK_TUNING (core/tuning.js): the share of each side searched
// (maxFrac), the middle band a profile runs across (band), the contrast a frame needs over
// the scan's brightness range (minContrast), how long the photograph must stay bright to
// begin (photoRun), how near the edge the frame must begin (frameStart), and how far a
// side may stray from its group (groupTolerance).

function median256(hist, n) {
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc * 2 >= n) return v
  }
  return 255
}

/**
 * The median of each row (`axis 'y'`) or column (`'x'`) of a w×h grey raster, over the
 * middle `band` of the other axis.
 */
export function bandProfile(gray, w, h, axis) {
  const n = axis === 'x' ? w : h,
    cross = axis === 'x' ? h : w
  const c0 = Math.floor((cross * (1 - T.band)) / 2),
    c1 = Math.ceil((cross * (1 + T.band)) / 2)
  const out = new Float32Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    hist.fill(0)
    for (let j = c0; j < c1; j++) hist[axis === 'x' ? gray[j * w + i] : gray[i * w + j]]++
    out[i] = median256(hist, c1 - c0)
  }
  return out
}

// The photograph begins where the profile stays above the threshold for `photoRun` of
// the side: a thin bright line inside the frame (the film edge, a light leak) does not end
// the frame.

/**
 * Where the frame ends walking in from one end of a profile: `{ at, contrast }`, `at`
 * the first index of the photograph (0 when no frame is found), `contrast` the photograph
 * level minus the frame's, over `range`. `fromEnd` walks in from the far end (`at` is
 * then counted from that end).
 */
export function frameEdge(profile, fromEnd, { maxFrac = T.maxFrac, range = 255 } = {}) {
  const n = profile.length
  const at = (k) => profile[fromEnd ? n - 1 - k : k]
  const limit = Math.max(2, Math.floor(n * maxFrac))
  // The photograph's level: the median of the profile's middle.
  const mid = Array.from(profile.slice(Math.floor(n * maxFrac), Math.ceil(n * (1 - maxFrac)))).sort((a, b) => a - b)
  const photo = mid.length ? mid[mid.length >> 1] : 255
  let dark = 255
  for (let k = 0; k < limit; k++) dark = Math.min(dark, at(k))
  const contrast = (photo - dark) / range
  if (!(contrast >= T.minContrast)) return { at: 0, contrast: Math.max(0, contrast) }
  const thr = dark + 0.5 * (photo - dark)
  const run = Math.max(2, Math.round(n * T.photoRun))
  // The first index from which the profile stays bright for `run`, after some dark that
  // begins near the edge (past a bright scanner bed at most): dark ground or a road
  // inside a photograph without a frame is no frame.
  const start = Math.max(2, Math.round(n * T.frameStart))
  let seenDark = false,
    bright = 0
  for (let k = 0; k < limit + run; k++) {
    if (at(k) < thr) {
      if (!seenDark && k > start) return { at: 0, contrast }
      seenDark = true
      bright = 0
    } else if (seenDark && ++bright >= run) return { at: k - run + 1, contrast }
  }
  return { at: 0, contrast }
}

/**
 * The frame on each side of a w×h grey raster: `{ top, right, bottom, left }` in raster
 * px (0 where none was found) and `contrast` per side.
 */
export function detectFrameMargins(gray, w, h, opts = {}) {
  let lo = 255,
    hi = 0
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < lo) lo = gray[i]
    if (gray[i] > hi) hi = gray[i]
  }
  const range = Math.max(1, hi - lo)
  const xs = bandProfile(gray, w, h, 'x'),
    ys = bandProfile(gray, w, h, 'y')
  const o = { ...opts, range }
  const left = frameEdge(xs, false, o),
    right = frameEdge(xs, true, o),
    top = frameEdge(ys, false, o),
    bottom = frameEdge(ys, true, o)
  return {
    top: top.at,
    right: right.at,
    bottom: bottom.at,
    left: left.at,
    contrast: { top: top.contrast, right: right.contrast, bottom: bottom.contrast, left: left.contrast },
  }
}

/**
 * Margins in raster px → native px (`sx`, `sy` the raster's size over the native per
 * axis), grown by `insetFrac` of the long side (the frame's notches and rounded corners
 * reach into the photograph), rounded outward. A side without a frame stays 0.
 */
export function nativeFrameMargins(m, sx, sy, natW, natH, insetFrac = 0) {
  const inset = insetFrac * Math.max(natW, natH)
  const side = (v, s) => (v > 0 ? Math.ceil(v / s + inset) : 0)
  return { top: side(m.top, sy), right: side(m.right, sx), bottom: side(m.bottom, sy), left: side(m.left, sx) }
}

// A camera's scans sit in the scanner almost alike: a side more than `groupTolerance` of
// the scan's side away from its group's median is taken as the median (dark ground or sky
// at the photograph's edge carried it on, or a bright mark cut it short).

/**
 * Margins of one group of scans of the same size made consistent: per side, a value more
 * than `groupTolerance` × the side from the group's median (of the sides found) is
 * replaced by it. `list`: `[{ top, right, bottom, left }]` in px of a w×h raster.
 * Returns the list with `{ ...margins, replaced: [sides] }`. Groups of fewer than three
 * are returned as they are.
 */
export function consistentMargins(list, w, h) {
  if (list.length < 3) return list.map((m) => ({ ...m, replaced: [] }))
  const med = {}
  for (const k of ['top', 'right', 'bottom', 'left']) {
    const v = list
      .map((m) => m[k])
      .filter((x) => x > 0)
      .sort((a, b) => a - b)
    med[k] = v.length * 2 > list.length ? v[v.length >> 1] : 0
  }
  return list.map((m) => {
    const out = { ...m, replaced: [] }
    for (const k of ['top', 'right', 'bottom', 'left']) {
      const tol = T.groupTolerance * (k === 'top' || k === 'bottom' ? h : w)
      if (med[k] > 0 && Math.abs(m[k] - med[k]) > tol) {
        out[k] = med[k]
        out.replaced.push(k)
      }
    }
    return out
  })
}
