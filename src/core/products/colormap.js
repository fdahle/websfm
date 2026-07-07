// Shared colour ramps for visualising scalar fields (depth maps, costs, …).
// Pure, no Vue/Pinia/OPFS/DOM/WASM — used by both the compute worker (when it
// bakes generated depth maps to PNG) and ViewerImage.vue (imported depth maps),
// which previously each carried their own copy of the ramp.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Turbo-ish ramp: maps a normalised value t∈[0,1] to [r,g,b] (0..255).
// Smooth blue → cyan → green → yellow → red.
export function depthColor(t) {
  const r = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 3), 0, 1))
  const g = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 2), 0, 1))
  const b = Math.round(255 * clamp(1.5 - Math.abs(4 * t - 1), 0, 1))
  return [r, g, b]
}
