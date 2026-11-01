// What each step of Co-register DEM does (CoregisterDemModal.vue): the stable ground it
// compares, the horizontal shift, the vertical shift, the tilt, and what it is applied
// to (core/products/demCoregistration.js).
import { COREG_TUNING } from '../tuning.js'

const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`

// The co-registration a georeference carries (the store's `coregistration`: its mean
// `move` [east, north, up], whether a tilt is in it), in one line.
export function describeCoregistration(c) {
  if (!c) return ''
  const [e, n, u] = c.move
  return `"${c.reference}" (moved E ${signed(e)}, N ${signed(n)}, Z ${signed(u)} m${c.tilt ? ', and tilted' : ''})`
}

// project: { demName, demInCrs (the DEM is in a CRS), demTiled (kept as tiles: past
//   one plane), demCrs, referenceName, stableName (null = every cell), georefCrs (the
//   georeference's CRS, null when there is none), current (the store's coregistration),
//   chain (the DEM was built in the co-registered georeference: a new move adds to it) }
// → { stable, horizontal, vertical, tilt, apply, current, blocked } — `blocked` is why
//   Run cannot go ahead, or null.
export function coregisterEffects(
  s,
  {
    demName = 'DEM',
    demInCrs = false,
    demTiled = false,
    demCrs = null,
    referenceName = null,
    stableName = null,
    georefCrs = null,
    current = null,
    chain = false,
  } = {},
) {
  const ref = referenceName ? `"${referenceName}"` : 'the reference DEM'
  const stable = stableName
    ? `Only the cells of "${demName}" inside "${stableName}" are compared with ${ref}: ground that changed stays out of the fit.`
    : `Every cell of "${demName}" is compared with ${ref}. Ground that changed since (ice, a river, new buildings) pulls the fit: choose a layer of stable ground.`
  const horizontal = s.horizontal
    ? `Shifts the DEM east and north until its slopes line up with the reference's (Nuth & Kääb), ` +
      `on cells sloping ${COREG_TUNING.minSlopeDeg}–${COREG_TUNING.maxSlopeDeg}°.`
    : 'Off: the DEM keeps its horizontal position.'
  const vertical = s.vertical
    ? `Removes the median height difference${s.horizontal ? ' left after the shift' : ''}.`
    : s.tilt === 'off'
      ? 'Off: the heights keep their offset.'
      : 'Off, but the tilt fit has a constant term, so it takes up the mean offset.'
  const georef = s.applyTo === 'georeference'
  const tilt =
    s.tilt === 'off'
      ? 'Off: no tilt is removed.'
      : s.tilt === 'plane'
        ? 'Fits a plane to the height differences left and removes it: the tilt of a block held by control on one side.'
        : georef
          ? 'A quadratic surface cannot move the georeference, which is shifted and turned but not bent: choose a plane, or apply it to the DEM.'
          : 'Fits a second-order surface to the height differences left and removes it: a tilt and a bend. Outside the stable ground it extrapolates.'

  let blocked = null
  if (!demInCrs)
    blocked = `"${demName}" is in the local frame: build the DEM in the project CRS to compare it with a reference.`
  else if (!referenceName) blocked = 'Import a reference DEM first (Import ▸ Reference DEM / Ortho).'
  else if (georef && s.tilt === 'quadratic') blocked = 'A quadratic tilt applies to the DEM only.'
  else if (georef && !georefCrs) blocked = 'The project has no georeference to move.'
  else if (georef && demCrs !== georefCrs)
    blocked = `"${demName}" is in ${demCrs}, the georeference in ${georefCrs}: build the DEM in the project CRS.`
  else if (!georef && demTiled)
    blocked = `"${demName}" is kept as tiles (over 4,096 cells a side): co-register it through the georeference, or build it at a coarser cell size.`
  else if (!s.horizontal && !s.vertical && s.tilt === 'off') blocked = 'Turn on at least one step.'

  const apply = georef
    ? `The georeference moves onto ${ref}${current ? (chain ? ', on top of the current move' : ', in place of the current move') : ''}: ` +
      'the DEMs and orthophotos built before are outdated, rebuild them. Every refit keeps the move until you remove it here.'
    : `A new DEM "${demName} (co-registered)" is added beside "${demName}"; the orthophoto and the model stay where they are.`
  return {
    stable,
    horizontal,
    vertical,
    tilt,
    apply,
    current: current ? `The georeference is co-registered to ${describeCoregistration(current)}.` : null,
    blocked,
  }
}
