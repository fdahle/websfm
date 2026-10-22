// What each step of Texture Mesh does to this project (TextureMeshModal.vue): the
// one-line effects under its numbered steps, in the order core/products/texture/
// texture.js runs them — visibility, view selection, charts and packing, then the
// bake with its colour levelling.
import { plural } from './format.js'

const SCALE = { 1: 'the photos’ native', 0.5: 'half the photos’', 0.25: 'a quarter of the photos’' }

// project: { triangles (of the mesh textured), cameras (registered) }
export function textureEffects(s, { triangles = 0, cameras = 0 } = {}) {
  const visibility = !cameras
    ? 'Build the sparse model first: texturing needs registered cameras.'
    : `Each of the ${plural(triangles, 'triangle')} is checked against the ${plural(cameras, 'photo')} for ` +
      'which see it, not hidden behind something nearer' +
      `${s.useMasks ? ', leaving masked pixels out' : ''}` +
      `${s.photoConsistency ? '; a photo that saw something else there than the others is dropped for it' : ''}.`

  const selection =
    'Each triangle takes the photo that sees it largest and sharpest, kept the same across neighbours with a ' +
    `seam penalty of ${s.smoothness}${s.smoothness === 0 ? ' (every triangle on its own)' : ''}; triangles no ` +
    `photo sees are ${s.unseen === 'remove' ? 'left out' : 'given a flat colour'}.`

  const atlas =
    `Cut out at ${SCALE[s.maxScale] ?? `${s.maxScale}×`} resolution onto pages of ${s.pageSize} × ${s.pageSize} px, ` +
    `at most ${plural(s.maxPages, 'page')}; when they do not fit, the resolution is lowered until they do.`

  const colour = s.levelColours
    ? 'Exposure and white balance are matched between neighbouring photos, and the seams levelled.'
    : 'Off: each photo keeps its own exposure, so brightness can step at a seam.'
  return { visibility, selection, atlas, colour }
}
