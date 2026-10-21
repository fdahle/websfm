// The similarity an export applies to model-frame coordinates, from THE resolver's
// answer (stores/reconstruction/frames.js effectiveFrameSpec). Pure, so the cloud,
// mesh and measurement exports all place coordinates by the same rule:
//   georeference  → the full CRS similarity (scale + rotation + translation)
//   orientation   → s·R·(p − origin), rows of R = east/north/up (s = the scale-bar
//                   scale when there is one, else 1)
//   scale bars    → a pure scale, no rotation, no origin shift
//   neither       → null (raw SfM coordinates, up to scale)
//
// The scale case is deliberately scale-ONLY rather than the whole scaled local
// frame. The orientation half of that frame is a *product* convention — DEM and
// ortho need a vertical axis, so buildLocalFrame guesses one (camera viewing
// dirs, else cloud PCA). For an object scan that guess is a PCA axis, and
// silently re-orienting an exported cloud by it would change more than the unit
// the user asked for. Metres in the model's own frame is the honest answer, and
// it is the answer with NO CRS attached (see D9 / WS0.4).
//
// → { sim: { scale, R, t, local? } | null, unit, crs: string | null,
//     source: 'georef' | 'scalebars' | 'orientation' | null, oriented? }
// `oriented`: the user's Orient model basis is applied (levelled, with its origin).
export function similarityForExport(resolved) {
  if (resolved?.source === 'georef') {
    const f = resolved.frameSpec
    return {
      sim: { scale: f.scale, R: f.R, t: f.t, local: f.local ?? null },
      unit: resolved.unit,
      crs: resolved.crs,
      source: 'georef',
    }
  }
  const f = resolved?.frameSpec
  const oriented = f?.east && f?.north && f?.up && f?.origin
  const s = resolved?.source === 'scalebars' ? resolved.scale : 1
  if (oriented) {
    const R = [f.east, f.north, f.up]
    const t = R.map((row) => -s * (row[0] * f.origin[0] + row[1] * f.origin[1] + row[2] * f.origin[2]))
    return {
      sim: { scale: s, R, t },
      unit: resolved.source === 'scalebars' ? 'm' : 'model',
      crs: null,
      source: resolved.source === 'scalebars' ? 'scalebars' : 'orientation',
      oriented: true,
    }
  }
  if (resolved?.source === 'scalebars') {
    return {
      sim: {
        scale: resolved.scale,
        R: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        t: [0, 0, 0],
      },
      unit: 'm',
      crs: null,
      source: 'scalebars',
    }
  }
  return { sim: null, unit: 'model', crs: null, source: null }
}
