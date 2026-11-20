// SIFT descriptor space — which normalisation a stored descriptor buffer is in, and
// the one conversion between them.
//
// The crate emits classic SIFT: L2-normalised, clamped at 0.2, re-normalised. websfm
// stores and matches **RootSIFT** (Arandjelović & Zisserman 2012, COLMAP's default
// `L1_ROOT`): L1-normalise, then take the element-wise square root. Euclidean distance
// between RootSIFT vectors is the Hellinger kernel between the original histograms,
// which downweights the few dominant gradient bins that make plain SIFT confuse
// similar-looking texture. The result is still unit-L2, so every distance and
// ratio-test path is unchanged.
//
// RootSIFT is a pure function of the stored L2 vector, so a project detected before
// the switch needs no re-detection: matching converts its descriptors on load
// (`toMatchSpace`). Mixing the two spaces without converting would be silent garbage:
// the ratio test still passes, just on the wrong distances. That is why the space is
// stamped on the image (`descNorm`) rather than inferred from the settings.
//
// **Stored as one byte per value** (since 2026-11): RootSIFT × 512, rounded, clamped at
// 255 (`rootSiftToU8`), COLMAP's own rule, so a COLMAP database round-trips its bytes
// unchanged. 128 B a keypoint instead of 512. RootSIFT values are non-negative and, out
// of the crate's clamped SIFT, at most ~0.29 (PUTI at 4,000 px, 384 k rows: max 0.285,
// none clamped), so the rounding error is 5.6e-4 RMS per value, ~0.3 % of a typical
// nearest-neighbour distance; on adjacent PUTI photos 0.06 % of the ratio-test
// putatives changed. A Uint8Array is always RootSIFT (nothing writes L2 as bytes);
// a Float32Array is an older project's, stamped as above. Matching widens the bytes
// (`descriptorsAsFloat`, ÷ 512, exact in a float): every dot product of two widened
// rows is then a multiple of 2⁻¹⁸ below 2⁶, so it is exact in Float32 whatever the
// summation order, and the WebGPU and WASM matchers agree bit for bit.

/** Normalisation stamps for SIFT descriptors. */
export const SIFT_DESC_NORM = Object.freeze({ L2: 'l2', ROOT: 'root' })

/**
 * RootSIFT in place: each `dim`-wide row becomes sqrt(row / L1(row)). SIFT rows are
 * non-negative; an all-zero row stays zero.
 *
 * @param {Float32Array} desc  N×dim, row-major — overwritten
 * @param {number} [dim]
 * @returns {Float32Array} `desc`
 */
export function rootSiftInPlace(desc, dim = 128) {
  for (let o = 0; o + dim <= desc.length; o += dim) {
    let l1 = 0
    for (let j = 0; j < dim; j++) l1 += Math.abs(desc[o + j])
    if (!(l1 > 0)) continue
    const inv = 1 / l1
    for (let j = 0; j < dim; j++) desc[o + j] = Math.sqrt(Math.abs(desc[o + j]) * inv)
  }
  return desc
}

/**
 * The normalisation an image's stored SIFT descriptors are in, or null for a
 * non-SIFT detector. An explicit `descNorm` stamp wins. Unstamped websfm detections
 * predate RootSIFT, so they are 'l2'. Features imported from a COLMAP database are
 * already RootSIFT, since that is COLMAP's default normalisation.
 *
 * @param {{detector?: string|null, descNorm?: string|null, detectSettings?: object|null}} img
 * @returns {'l2'|'root'|null}
 */
export function siftDescNorm(img) {
  if ((img?.detector ?? 'sift') !== 'sift') return null
  if (img.descNorm === SIFT_DESC_NORM.ROOT || img.descNorm === SIFT_DESC_NORM.L2) return img.descNorm
  return img.detectSettings?.source === 'colmap' ? SIFT_DESC_NORM.ROOT : SIFT_DESC_NORM.L2
}

/**
 * Descriptors in the space matching runs in: RootSIFT for SIFT, untouched for every
 * other detector. A legacy L2 buffer is converted into a NEW array, because the
 * caller's buffer may be the image's live in-memory copy; converting that in place
 * would double-convert on the next run.
 *
 * @param {Float32Array|null} desc
 * @param {object} img  image record (see `siftDescNorm`)
 * @param {number} [dim]
 */
export function toMatchSpace(desc, img, dim = 128) {
  if (!desc || desc instanceof Uint8Array || siftDescNorm(img) !== SIFT_DESC_NORM.L2) return desc
  return rootSiftInPlace(desc.slice(), dim)
}

/** The scale of stored uint8 RootSIFT: byte = round(value × 512), clamped at 255. */
export const SIFT_U8_SCALE = 512

/**
 * Descriptors as floats, for the matchers and retrieval: stored uint8 RootSIFT widened
 * (byte ÷ 512) into a new Float32Array; a Float32Array (learned descriptors, an older
 * project's SIFT) passes through. Null stays null.
 *
 * @param {Float32Array|Uint8Array|null} desc
 * @returns {Float32Array|null}
 */
export function descriptorsAsFloat(desc) {
  if (!(desc instanceof Uint8Array)) return desc
  const out = new Float32Array(desc.length)
  const inv = 1 / SIFT_U8_SCALE
  for (let k = 0; k < desc.length; k++) out[k] = desc[k] * inv
  return out
}

/**
 * RootSIFT as COLMAP-style uint8 (× 512, clamped at 255): what detection stores, what
 * guided track extension gets (stores/reconstruction/sparseRun.js) and what a COLMAP
 * database export writes, Math.min(255, Math.round(v · 512)) per value (a negative
 * value, which RootSIFT never has, to 0). Bytes pass through: they are this encoding
 * already. For a Float32Array, v · 512 + 0.5 is exact in a double (a power-of-two scale
 * of a 24-bit value under 2¹⁰), so the truncation is Math.round's result for every
 * non-negative value and NaN (0 either way); ~4× faster, which on a 347-image block was
 * seconds of the page's main thread before SfM started. Other arrays take Math.round.
 *
 * @param {Float32Array|Float64Array|Uint8Array|number[]} d
 * @returns {Uint8Array}
 */
export function rootSiftToU8(d) {
  if (d instanceof Uint8Array) return d
  const u8 = new Uint8Array(d.length)
  if (d instanceof Float32Array) {
    for (let k = 0; k < d.length; k++) {
      const v = d[k] >= 0 ? (d[k] * SIFT_U8_SCALE + 0.5) | 0 : 0
      u8[k] = v > 255 ? 255 : v
    }
  } else for (let k = 0; k < d.length; k++) u8[k] = Math.max(0, Math.min(255, Math.round(d[k] * SIFT_U8_SCALE)))
  return u8
}
