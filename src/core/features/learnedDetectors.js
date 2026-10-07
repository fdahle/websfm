// The learned (ONNX) keypoint detectors and what each one implies downstream.
//
// SIFT is the built-in WASM detector; every other detector id is a learned one
// listed here. Code that used to ask `detector === 'superpoint'` asks
// `isLearnedDetector(detector)` and reads the spec, so adding a detector is one
// entry here plus its weights in core/models/registry.js.
//
// Each detector pairs with ONE LightGlue: LightGlue is trained per descriptor, so
// its weights are chosen by the images' detector (`matcherModelId`), never by a
// setting. Two images detected by different detectors cannot be matched at all.
import { SUPERPOINT_TILE_ALIGN } from './tiling.js'

export const LEARNED_DETECTORS = {
  superpoint: {
    id: 'superpoint', label: 'SuperPoint', modelId: 'superpoint', matcherModelId: 'lightglue',
    // Input [1,1,H,W] luma in [0,1]; output cell 8 px.
    descDim: 256, channels: 1, tileAlign: SUPERPOINT_TILE_ALIGN,
  },
  disk: {
    id: 'disk', label: 'DISK', modelId: 'disk', matcherModelId: 'lightglue_disk',
    // Input [1,3,H,W] RGB in [0,1]. Its U-Net pads to a multiple of 16
    // internally; tile origins sit on that grid so a tile matches the untiled run.
    descDim: 128, channels: 3, tileAlign: 16,
  },
}

/** Every detector id, built-in first. */
export const DETECTOR_IDS = ['sift', ...Object.keys(LEARNED_DETECTORS)]

/** The learned-detector spec for `id`, or null for SIFT / unknown. */
export function learnedDetector(id) {
  return LEARNED_DETECTORS[id] ?? null
}

export function isLearnedDetector(id) {
  return !!LEARNED_DETECTORS[id]
}

/** Message-text label: 'SIFT', 'SuperPoint', 'DISK'. */
export function detectorLabel(id) {
  return LEARNED_DETECTORS[id]?.label ?? 'SIFT'
}

/**
 * Descriptor width a detector produces. Images carry their own `descDim`; this is
 * for code that must know it before any image has been detected.
 */
export function detectorDescDim(id) {
  return LEARNED_DETECTORS[id]?.descDim ?? 128
}

/**
 * Which LightGlue model matches a set of images, or why none can. LightGlue needs
 * every image detected by the SAME learned detector at that detector's width.
 * @param {{name?:string, detector?:string, descDim?:number}[]} images
 * @returns {{ ok:true, detector:string, modelId:string } | { ok:false, reason:string, bad:object[] }}
 */
export function lightGlueModelFor(images) {
  const detectors = new Set(images.map((im) => im.detector ?? 'sift'))
  const learned = [...detectors].filter(isLearnedDetector)
  if (detectors.size === 1 && learned.length === 1) {
    const spec = LEARNED_DETECTORS[learned[0]]
    const bad = images.filter((im) => (im.descDim ?? 128) !== spec.descDim)
    if (!bad.length) return { ok: true, detector: spec.id, modelId: spec.matcherModelId }
    return { ok: false, bad, reason: `${spec.label} images must carry ${spec.descDim}-d descriptors` }
  }
  // Most common learned detector is the one the user most likely meant.
  const counts = {}
  for (const im of images) counts[im.detector ?? 'sift'] = (counts[im.detector ?? 'sift'] ?? 0) + 1
  const target = learned.sort((a, b) => counts[b] - counts[a])[0]
  const bad = images.filter((im) => (im.detector ?? 'sift') !== target)
  if (!target) {
    return { ok: false, bad, reason: 'LightGlue needs a learned detector (SuperPoint or DISK)' }
  }
  return { ok: false, bad, reason: `LightGlue needs every image detected with one learned detector (${detectorLabel(target)})` }
}
