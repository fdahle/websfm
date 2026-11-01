// Depth maps on a slow GPU: one map is computed on the CPU to compare, and the run goes
// on with the faster (workers/ops/dense.js). That CPU map gives up after a pyramid level
// once it cannot win, instead of finishing a map the GPU does many times faster.
import { DENSE_TUNING } from '../tuning.js'

// After a pyramid level: give up when the CPU map has taken as long as the GPU would for
// the whole map, or is on course (elapsed / fraction done) to take giveUp× that. Coarse
// levels cost the CPU more per pixel than the finest, hence the margin. The last level
// done (fraction 1) leaves only the planar prior: the map finishes.
//   elapsedMs, fraction (0..1 of the map's levels), gpuMapMs (the GPU's time for it)
export function probeGivesUp(elapsedMs, fraction, gpuMapMs, giveUp = DENSE_TUNING.gpuProbeGiveUp) {
  if (!(fraction < 1) || !(gpuMapMs > 0)) return false
  return elapsedMs >= gpuMapMs || elapsedMs / Math.max(fraction, 1e-6) >= giveUp * gpuMapMs
}
