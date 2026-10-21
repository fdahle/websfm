// An image's keypoints as typed arrays — never one JS object per keypoint
// (TODO ▸ SC-3). An object per keypoint ({x, y, nx, ny, scale, response, color}) was
// ~150 B of V8 heap each: 0.39 GB for quarry's 2.56 M keypoints, and the heap ceiling
// at ~25 M. Here a keypoint is 24 B + 3 B, outside the heap, and the in-memory layout
// IS the on-disk one (keypoints/{uuid}.bin, keypoint_colors/{uuid}.bin), so a restore
// wraps the file's bytes instead of parsing them.
//
//   data  Float32Array, KP_STRIDE per keypoint: x, y (native px), nx, ny (detect-
//         normalised 0..1), scale (native px), response
//   rgb   Uint8Array 3 per keypoint, or null (no colours recorded)
//
// Read with the accessors (`kps.x(i)`); `length` is the keypoint count. A copy
// posted to a worker arrives as a plain { data, rgb, length } object (structured
// clone drops the class) — workers read `data` with KP_STRIDE, or rewrap it.

export const KP_STRIDE = 6

export class Keypoints {
  constructor(data = new Float32Array(0), rgb = null) {
    this.data = data
    this.rgb = rgb
    this.length = Math.floor(data.length / KP_STRIDE)
  }
  x(i) {
    return this.data[KP_STRIDE * i]
  }
  y(i) {
    return this.data[KP_STRIDE * i + 1]
  }
  nx(i) {
    return this.data[KP_STRIDE * i + 2]
  }
  ny(i) {
    return this.data[KP_STRIDE * i + 3]
  }
  scale(i) {
    return this.data[KP_STRIDE * i + 4]
  }
  response(i) {
    return this.data[KP_STRIDE * i + 5]
  }
  /** [r, g, b] or null — allocates; for colouring passes use `rgb` directly. */
  color(i) {
    return this.rgb ? [this.rgb[3 * i], this.rgb[3 * i + 1], this.rgb[3 * i + 2]] : null
  }
}

export const isKeypoints = (k) => k instanceof Keypoints

/** Rewrap a structured-cloned copy (a plain { data, rgb }) — or pass one through. */
export function asKeypoints(k) {
  if (k instanceof Keypoints) return k
  if (k?.data instanceof Float32Array) return new Keypoints(k.data, k.rgb ?? null)
  return keypointsFromObjects(k)
}

export const EMPTY_KEYPOINTS = new Keypoints()

/**
 * Pack a list of keypoint objects ({ x, y, nx?, ny?, scale?, response?, color? }) — an
 * import (COLMAP, an external project) or a test fixture.
 */
export function keypointsFromObjects(list) {
  const n = list?.length ?? 0
  const data = new Float32Array(KP_STRIDE * n)
  let rgb = null
  for (let i = 0; i < n; i++) {
    const k = list[i],
      o = KP_STRIDE * i
    data[o] = k.x
    data[o + 1] = k.y
    data[o + 2] = k.nx ?? 0
    data[o + 3] = k.ny ?? 0
    data[o + 4] = k.scale ?? 0
    data[o + 5] = k.response ?? 0
    if (k.color) {
      rgb ??= new Uint8Array(3 * n)
      rgb[3 * i] = k.color[0]
      rgb[3 * i + 1] = k.color[1]
      rgb[3 * i + 2] = k.color[2]
    }
  }
  return new Keypoints(data, rgb)
}

/** One keypoint as an object (exports, diagnostics; allocates). */
export function keypointAt(kps, i) {
  return { x: kps.x(i), y: kps.y(i), nx: kps.nx(i), ny: kps.ny(i), scale: kps.scale(i), response: kps.response(i) }
}

/**
 * Fill nx, ny (0..1, what the overlays draw with) from native x, y for keypoints
 * that arrived without them — an import (a COLMAP database records x, y only).
 * In place; returns the set. No-op without image dimensions.
 */
export function fillNormalized(kps, width, height) {
  if (!(width > 0) || !(height > 0)) return kps
  const d = kps.data
  for (let i = 0; i < kps.length; i++) {
    const o = KP_STRIDE * i
    if (d[o + 2] === 0 && d[o + 3] === 0) {
      d[o + 2] = d[o] / width
      d[o + 3] = d[o + 1] / height
    }
  }
  return kps
}
