// One image's keypoints for the SfM worker, as typed arrays (pure).
//
//   { n, xy: Float64Array(2n), scale: Float32Array(n) | null,
//     rgb: Uint8Array(3n) | null, hasColor: Uint8Array(n) | null }
//
// `scale` is the detector's keypoint scale in native pixels (core/features/keypoints.js
// slot 4: SIFT's blob σ), which weighs a tie observation (baObservations.js
// tieScaleWeights). 0 where the detector gives none (the learned detectors, matched
// points imported without one); null when no keypoint of the image has one.
//
// Positions are native pixel-centre coordinates (whatever frame the run has moved
// them to: ingest undistortion, the film canonical frame, the self-cal fold). A
// keypoint with no colour has hasColor[k] = 0; a set with no colour at all has
// rgb = hasColor = null. A missing keypoint (only tests produce one) is NaN.
//
// IMMUTABLE BY CONTRACT. Nothing writes into `xy` after construction: every move
// (`mapPositions`) returns a new set sharing `rgb`/`hasColor`. That is what lets one
// set be shared by the pristine input, every sub-run's working copy and the self-cal
// snapshot without copying it (sfm.js cloneSfmInput), and why a snapshot is free.
//
// Replaces arrays of `{x, y, color}` objects: ~104 B per keypoint per copy as JS
// objects, 16–24 B here (TODO ▸ MEM; measured in HANDOVER ▸ B-mem).

import { KP_STRIDE } from '../features/keypoints.js'

export function isKeypointSet(v) {
  return !!v && v.xy instanceof Float64Array
}

/** A positive, finite keypoint scale, else 0 (none). */
const scaleOrZero = (v) => (Number.isFinite(v) && v > 0 ? v : 0)

/**
 * A set from the store's typed keypoints (core/features/keypoints.js: `data` with
 * KP_STRIDE, optional `rgb`) or from `[{x, y, scale?, color?}]` (tests, worker callers,
 * the bench's SfM input dumps); a set is returned unchanged.
 */
export function keypointSetFrom(objects) {
  if (isKeypointSet(objects)) return objects
  if (objects?.data instanceof Float32Array) {
    const { data, rgb } = objects
    const n = Math.floor(data.length / KP_STRIDE)
    const xy = new Float64Array(2 * n)
    let scale = null
    for (let k = 0; k < n; k++) {
      xy[2 * k] = data[KP_STRIDE * k]
      xy[2 * k + 1] = data[KP_STRIDE * k + 1]
      const s = scaleOrZero(data[KP_STRIDE * k + 4])
      if (s) (scale ??= new Float32Array(n))[k] = s
    }
    const colored = rgb?.length === 3 * n
    return { n, xy, scale, rgb: colored ? rgb.slice() : null, hasColor: colored ? new Uint8Array(n).fill(1) : null }
  }
  const list = objects ?? []
  const n = list.length
  const xy = new Float64Array(2 * n)
  let rgb = null,
    hasColor = null,
    scale = null
  for (let k = 0; k < n; k++) {
    const kp = list[k]
    if (!kp) {
      xy[2 * k] = NaN
      xy[2 * k + 1] = NaN
      continue
    }
    xy[2 * k] = kp.x
    xy[2 * k + 1] = kp.y
    const s = scaleOrZero(kp.scale)
    if (s) (scale ??= new Float32Array(n))[k] = s
    const c = kp.color
    if (c) {
      if (!rgb) {
        rgb = new Uint8Array(3 * n)
        hasColor = new Uint8Array(n)
      }
      rgb[3 * k] = c[0]
      rgb[3 * k + 1] = c[1]
      rgb[3 * k + 2] = c[2]
      hasColor[k] = 1
    }
  }
  return { n, xy, scale, rgb, hasColor }
}

export const kpX = (set, k) => set.xy[2 * k]
export const kpY = (set, k) => set.xy[2 * k + 1]

/** True when keypoint k exists (in range, not a missing slot). */
export function hasKp(set, k) {
  // NaN !== NaN; an out-of-range read is undefined, which also fails.
  // eslint-disable-next-line no-self-compare
  return !!set && k < set.n && set.xy[2 * k] === set.xy[2 * k]
}

/**
 * A new set with every position passed through `fn(x, y, k) → {x, y}`; scales and
 * colours are shared. Missing (NaN) keypoints stay missing.
 */
export function mapPositions(set, fn) {
  const xy = new Float64Array(2 * set.n)
  const src = set.xy
  for (let k = 0; k < set.n; k++) {
    const x = src[2 * k]
    // eslint-disable-next-line no-self-compare
    if (x !== x) {
      xy[2 * k] = NaN
      xy[2 * k + 1] = NaN
      continue
    }
    const p = fn(x, src[2 * k + 1], k)
    xy[2 * k] = p.x
    xy[2 * k + 1] = p.y
  }
  return { n: set.n, xy, scale: set.scale ?? null, rgb: set.rgb, hasColor: set.hasColor }
}

/**
 * The finest scale among an image's keypoints (`s₀` of the tie weight, baObservations.js),
 * or 0 when none has one. Cached on the set (immutable, shared by every copy).
 */
const minScaleCache = new WeakMap()
export function minKeypointScale(set) {
  const sc = set?.scale
  if (!sc) return 0
  let m = minScaleCache.get(sc)
  if (m !== undefined) return m
  m = Infinity
  for (let k = 0; k < sc.length; k++) if (sc[k] > 0 && sc[k] < m) m = sc[k]
  if (m === Infinity) m = 0
  minScaleCache.set(sc, m)
  return m
}

/** The buffers to transfer when posting a set to a worker. */
export function keypointSetTransfer(set) {
  return [
    set.xy.buffer,
    ...(set.scale ? [set.scale.buffer] : []),
    ...(set.rgb ? [set.rgb.buffer, set.hasColor.buffer] : []),
  ]
}
