// PatchMatch refinement schedule — how large the random depth/normal proposals are on
// each sweep. Both kernels apply it the same way (mvs.rs computes the scale from
// `perturbStart`; patchmatch.wgsl receives it per sweep from depthMapGpu.js):
//
//   scale(it)   = perturbStart · 0.5^it
//   depth step  = ±0.5 · scale · min(the pixel's current depth, the depth range)
//   normal step = ±0.5 · scale per tangent component, −0.3 · scale on n_z
//
// Two things this replaced. The depth step was a fraction of the global depth RANGE
// only, so on a deep scene (ground-level, oblique: 5–10× depth range) it was useless
// to a near pixel; it is now relative to the pixel's own depth (COLMAP's PerturbDepth),
// bounded by the range so a shallow scene keeps its finer, range-sized steps. And
// every pyramid level restarted at scale 1, so a level seeded by the coarser solution
// spent its first sweeps on ±50 %-of-range proposals and never got below ±12 % of
// range with the default three iterations — fine detail came only from propagation. Now each finer level starts at twice the scale the coarser level ended
// on: the factor 2 is headroom for the upsampled seed, whose error is about one coarse
// pixel, i.e. about the precision the coarser level had reached.

// Refinement scale of sweep `it` for a level started at `perturbStart`.
export function refineScale(perturbStart, it) {
  return (perturbStart > 0 ? perturbStart : 1) * 0.5 ** it
}

// `perturbStart` for each pyramid level, coarsest first, given each level's sweep count.
export function levelPerturbStarts(levelIters) {
  const out = []
  let start = 1
  for (const iters of levelIters) {
    out.push(start)
    start = Math.min(1, 2 * refineScale(start, Math.max(1, iters) - 1))
  }
  return out
}
