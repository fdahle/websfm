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
  if (!desc || siftDescNorm(img) !== SIFT_DESC_NORM.L2) return desc
  return rootSiftInPlace(desc.slice(), dim)
}
