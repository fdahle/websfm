// What each step of Build Mesh does to this project (MeshModal.vue): the one-line
// effects under its numbered steps, in the order core/products/mesh.js runs them —
// solve, trim, refill small holes, drop floating pieces, colour.
import { plural } from './format.js'

const TRIM = {
  gentle: 'Surface no points support is removed: the hull the solve extrapolates and the shells around stray specks',
  strong:
    'Surface no points support is removed, and thinly observed surface too; this can open holes where coverage is sparse',
}

// source: { name, count } of the dense cloud meshed, or null.
export function meshEffects(s, { source = null } = {}) {
  const solve = !source
    ? 'No dense cloud with normals yet: run Densify first.'
    : `Screened Poisson over the ${plural(source.count, 'point')} of "${source.name}", at octree depth ` +
      `${s.depth} (lowered when the cloud is too sparse for it), fitting the points with screening weight ` +
      `${s.screening}${s.screening === 0 ? ', the smoothest' : ''}.`

  const dist = s.distanceTrim > 0 ? `triangles farther than ${s.distanceTrim} sample spacings from any point` : ''
  const trim =
    s.trim === 'off'
      ? `Off: the whole closed surface is kept, the hull past the data included${dist ? `, except ${dist}` : ''}.`
      : `${TRIM[s.trim] ?? ''}${dist ? `, as are ${dist}` : ''}.`

  const holes =
    s.trim === 'off'
      ? 'Not used: nothing is trimmed, so there are no holes to close.'
      : s.fillHoles
        ? 'Small holes the trimming opened are closed where the surrounding surface is solid.'
        : 'Off: holes the trimming opened stay open.'

  const floaters = s.removeFloaters
    ? `Disconnected pieces supported by less than ${s.minPiecePct} % of the main surface's points are removed.`
    : 'Off: every disconnected piece is kept.'

  const colour = s.colorize
    ? 'Each vertex takes the colour of the nearest dense point.'
    : 'Off: the mesh has no colour (Texture can add a photo texture later).'
  return { solve, trim, holes, floaters, colour }
}
