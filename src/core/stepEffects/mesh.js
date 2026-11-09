// What each step of Build Mesh does to this project (MeshModal.vue): the one-line
// effects under its numbered steps, in the order core/products/mesh.js runs them —
// solve, trim, refill small holes, drop floating pieces, colour.
import { plural, fmtCount } from './format.js'
import { autoMeshDepth, predictMeshTriangles } from '../products/mesh.js'
import { MESH_TUNING } from '../tuning.js'

// A triangle count as people say it: 650 k, 1.2 M.
export function fmtTriangles(n) {
  if (n >= 1e6) return `${Number((n / 1e6).toPrecision(2))} M`
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString('en-US')} k`
  return fmtCount(n)
}

// The depth this run solves at and what it makes: Auto's pick from `basis` ({ count,
// spacing, extent }, MeshModal's meshDepthInputs), or the depth set. Null fields where
// the basis is unknown (an imported cloud's spacing is estimated by the run).
export function meshDepthPlan(s, basis = null) {
  const known = basis && basis.count > 0 && basis.spacing > 0 && basis.extent > 0
  if (s.depth > 0) {
    const triangles = known ? predictMeshTriangles(s.depth, basis) : null
    return {
      auto: false,
      depth: s.depth,
      triangles,
      leafSpacings: known ? basis.extent / 2 ** s.depth / basis.spacing : null,
    }
  }
  if (!known) return { auto: true, depth: null, triangles: null, leafSpacings: null }
  const a = autoMeshDepth(basis, s)
  return { auto: true, depth: a.depth, triangles: a.triangles, leafSpacings: a.leaf / basis.spacing, limit: a.limit }
}

const TRIM = {
  gentle: 'Surface no points support is removed: the hull the solve extrapolates and the shells around stray specks',
  strong:
    'Surface no points support is removed, and thinly observed surface too; this can open holes where coverage is sparse',
}

// source: { name, count } of the dense cloud meshed, or null.
// source: { name, count } of the dense cloud meshed, or null; basis: meshDepthPlan's.
export function meshEffects(s, { source = null, basis = null } = {}) {
  const plan = meshDepthPlan(s, basis)
  const what = [
    plan.leafSpacings ? `leaves of ${Number(plan.leafSpacings.toPrecision(2))} point spacings` : '',
    plan.triangles ? `about ${fmtTriangles(plan.triangles)} triangles` : '',
  ].filter(Boolean)
  const depth = !plan.auto
    ? `at octree depth ${s.depth} (${[...what, 'lowered when the cloud is too sparse for it'].join(', ')})`
    : plan.depth == null
      ? `at the octree depth for leaves of about ${s.leafSpacings} point spacings and at most ` +
        `${fmtTriangles(s.maxTriangles)} triangles, picked from the cloud when it runs`
      : `at octree depth ${plan.depth} (${what.join(', ')}): ` +
        (plan.limit === 'triangles'
          ? `the most detail within ${fmtTriangles(s.maxTriangles)} triangles`
          : `the depth for leaves of about ${s.leafSpacings} point spacings`)
  const heavy =
    plan.triangles > MESH_TUNING.warnTriangles ? ' A mesh this size may need more memory than a browser tab has.' : ''
  const solve = !source
    ? 'No dense cloud with normals yet: run Densify first.'
    : `Screened Poisson over the ${plural(source.count, 'point')} of "${source.name}", ${depth}, fitting the ` +
      `points with screening weight ${s.screening}${s.screening === 0 ? ', the smoothest' : ''}.` +
      (s.tiles === 'off'
        ? ' Always in one piece: a scene too large for one solve stops with a message.'
        : ' In tiles, welded at their seams, if one solve would not fit in memory.') +
      heavy

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

// The steps' short facts for Build Mesh's step chain (≤ SHORT_MAX characters).
export function meshShorts(s, { source = null, basis = null } = {}) {
  const plan = meshDepthPlan(s, basis)
  const solve = !source
    ? 'no dense cloud'
    : plan.depth == null
      ? `auto depth · ≤ ${fmtTriangles(s.maxTriangles)} triangles`
      : `depth ${plan.depth}${plan.auto ? ' (auto)' : ''}` +
        (plan.triangles ? ` · ≈ ${fmtTriangles(plan.triangles)} triangles` : ` · screening ${s.screening}`)
  return {
    solve,
    trim: s.trim === 'off' ? 'off' : s.trim,
    holes: s.trim === 'off' ? 'nothing trimmed' : s.fillHoles ? 'small holes closed' : 'off',
    floaters: s.removeFloaters ? `< ${s.minPiecePct} % pieces out` : 'off',
    colour: s.colorize ? 'from the cloud' : 'off',
  }
}
