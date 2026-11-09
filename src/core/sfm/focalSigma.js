// What a solved focal's standard deviation means for the model (bundle.rs ▸ lens σ).
// With the cameras where they are, a focal off by a share ε puts every height off by
// about ε of the distance from the cameras to the ground: on a nadir block the focal and
// that distance trade one for the other, so σ_f / f is how far the heights can be
// trusted from the focal alone. Pure.

// Past this share the photos do not fix the focal: a nadir block without positions in
// the solve, GCPs or oblique photos (bundle.rs a_nadir_block_without_control…).
export const FOCAL_UNFIXED_SHARE = 0.02

/** A focal σ share as a percentage, as the log and the Quality Report write it. */
export const focalSigmaPct = (share) => {
  const p = 100 * share
  // One significant figure below 0.1 %, so ± 0.3 px of 5,671 reads 0.005 %, not 0.00 %.
  return p >= 1 ? p.toFixed(0) : p >= 0.1 ? p.toFixed(1) : String(+p.toPrecision(1))
}

/** The focal's σ as a share of the focal; null when either is not usable. */
export function focalSigmaShare(fx, sigmaPx) {
  return fx > 0 && sigmaPx > 0 ? sigmaPx / fx : null
}

/** One log sentence for a solved focal `fx` ± `sigmaPx` (pixels). */
export function focalSigmaNote(fx, sigmaPx) {
  const share = focalSigmaShare(fx, sigmaPx)
  if (share == null) return ''
  if (share >= FOCAL_UNFIXED_SHARE) {
    return (
      `the focal is not fixed by these photos (± ${focalSigmaPct(share)} %), and heights scale with it: camera ` +
      'positions with their accuracies, GCPs or some oblique photos fix it'
    )
  }
  return (
    `focal ± ${sigmaPx.toFixed(1)} px (± ${focalSigmaPct(share)} %): on its own that moves heights by about ` +
    `± ${focalSigmaPct(share)} % of the distance from the cameras to the ground`
  )
}
