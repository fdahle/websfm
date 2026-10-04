// Conservative scheduling estimate, not a measurement of browser peak memory.
// Allow room for the SIFT pyramid/scratch arrays and full-size image decoding.
import { resolveDetectMaxDim } from './detectResolution.js'

export function detectionConcurrency(images, settings, poolSize, deviceMemoryGB = null) {
  if (settings.detector === 'superpoint' || !images.length) return 1
  const budget = Math.min(1024, deviceMemoryGB > 0 ? deviceMemoryGB * 256 : 512) * 1024 ** 2
  let largest = 1
  for (const image of images) {
    const w = image.meta?.width, h = image.meta?.height
    if (!(w > 0 && h > 0)) return 1
    const maxDim = resolveDetectMaxDim(Math.max(w, h), settings).maxDim
    const scale = Math.min(1, maxDim > 0 ? maxDim / Math.max(w, h) : 1)
    largest = Math.max(largest, w * h * (8 + 80 * scale * scale))
  }
  return Math.max(1, Math.min(4, poolSize, images.length, Math.floor(budget / largest)))
}

// Fiducial detection decodes every scan at full resolution (the native refine
// crops from the bitmap), so its peak is the decoded RGBA plus decode transients —
// ~8 B/px, i.e. ~780 MB for a 97 MP film scan — not the SIFT pyramid. Same budget.
export function fiducialDetectionConcurrency(images, poolSize, deviceMemoryGB = null) {
  if (!images.length) return 1
  const budget = Math.min(1024, deviceMemoryGB > 0 ? deviceMemoryGB * 256 : 512) * 1024 ** 2
  let largest = 1
  for (const image of images) {
    const w = image.meta?.width, h = image.meta?.height
    if (!(w > 0 && h > 0)) return 1
    largest = Math.max(largest, w * h * 8)
  }
  return Math.max(1, Math.min(4, poolSize, images.length, Math.floor(budget / largest)))
}
