// What each step of Crop Cloud / Crop Mesh does (CropCloudModal.vue): the box, then
// what is kept, with the dialog's live count (core/products/cloudEdit.js `cropCloud`,
// meshEdit.js `cropMesh`).
import { fmtCount } from './format.js'

const side = (lo, hi) => {
  const a = Number.isFinite(lo),
    b = Number.isFinite(hi)
  return a && b ? `${lo} – ${hi}` : a ? `from ${lo}` : b ? `up to ${hi}` : 'open'
}

// project: { kept (live count, or null when not counted), total, noun ('points' |
//   'vertices'), mesh, streamed }
export function cropCloudEffects(s, { kept = null, total = 0, noun = 'points', mesh = false, streamed = false } = {}) {
  const box = `X ${side(s.minX, s.maxX)} · Y ${side(s.minY, s.maxY)} · Z ${side(s.minZ, s.maxZ)}.`
  const where = s.invert ? 'outside' : 'inside'
  const keep = streamed
    ? s.invert
      ? 'The points outside the box go into a new streamed cloud, at full detail.'
      : 'The points inside the box are copied out of the octree into a new cloud; past 25 million points the copy is thinned evenly.'
    : kept !== null
      ? `Keeps ${fmtCount(kept)} of ${fmtCount(total)} ${noun}, ${where} the box` +
        `${mesh ? '; a triangle stays when all three corners do' : ''}.`
      : `${fmtCount(total)} ${noun}: too many to count live. The ${noun} ${where} the box are kept.`
  return { box, keep }
}
