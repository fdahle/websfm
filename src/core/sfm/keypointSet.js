// One image's keypoints for the SfM worker, as typed arrays (pure).
//
//   { n, xy: Float64Array(2n), rgb: Uint8Array(3n) | null, hasColor: Uint8Array(n) | null }
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
// objects, 16–20 B here (TODO ▸ MEM; measured in HANDOVER ▸ B-mem).

export function isKeypointSet(v) {
  return !!v && v.xy instanceof Float64Array
}

/** A set from `[{x, y, color?}]` (store / tests); a set is returned unchanged. */
export function keypointSetFrom(objects) {
  if (isKeypointSet(objects)) return objects
  const list = objects ?? []
  const n = list.length
  const xy = new Float64Array(2 * n)
  let rgb = null, hasColor = null
  for (let k = 0; k < n; k++) {
    const kp = list[k]
    if (!kp) { xy[2 * k] = NaN; xy[2 * k + 1] = NaN; continue }
    xy[2 * k] = kp.x; xy[2 * k + 1] = kp.y
    const c = kp.color
    if (c) {
      if (!rgb) { rgb = new Uint8Array(3 * n); hasColor = new Uint8Array(n) }
      rgb[3 * k] = c[0]; rgb[3 * k + 1] = c[1]; rgb[3 * k + 2] = c[2]
      hasColor[k] = 1
    }
  }
  return { n, xy, rgb, hasColor }
}

export const kpX = (set, k) => set.xy[2 * k]
export const kpY = (set, k) => set.xy[2 * k + 1]

/** True when keypoint k exists (in range, not a missing slot). */
export function hasKp(set, k) {
  // NaN !== NaN; an out-of-range read is undefined, which also fails.
  // eslint-disable-next-line no-self-compare
  return !!set && k < set.n && set.xy[2 * k] === set.xy[2 * k]
}

/** [r, g, b] or null. Allocates; for per-point colour, not hot loops. */
export function kpColor(set, k) {
  return set?.hasColor?.[k] ? [set.rgb[3 * k], set.rgb[3 * k + 1], set.rgb[3 * k + 2]] : null
}

/**
 * A new set with every position passed through `fn(x, y, k) → {x, y}`; colours are
 * shared. Missing (NaN) keypoints stay missing.
 */
export function mapPositions(set, fn) {
  const xy = new Float64Array(2 * set.n)
  const src = set.xy
  for (let k = 0; k < set.n; k++) {
    const x = src[2 * k]
    // eslint-disable-next-line no-self-compare
    if (x !== x) { xy[2 * k] = NaN; xy[2 * k + 1] = NaN; continue }
    const p = fn(x, src[2 * k + 1], k)
    xy[2 * k] = p.x; xy[2 * k + 1] = p.y
  }
  return { n: set.n, xy, rgb: set.rgb, hasColor: set.hasColor }
}

/** The buffers to transfer when posting a set to a worker. */
export function keypointSetTransfer(set) {
  return [set.xy.buffer, ...(set.rgb ? [set.rgb.buffer, set.hasColor.buffer] : [])]
}
