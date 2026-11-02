// What each step of Footprints from Poses does (FootprintFromPosesModal.vue): the ground
// the corner rays are cast onto, then which cameras can cast them (stores/
// useFootprintsStore.js ▸ computeFromPoses, whose skip reasons the modal counts).
import { fmtCount, plural } from './format.js'

// The reasons a pose gets no footprint, in the order the run tests them.
const REASONS = {
  noPose: 'no X/Y position',
  noElevation: 'no height (Z)',
  noAngles: 'no orientation angles (Assume nadir is off)',
  noSensor: 'no calibrated sensor or intrinsics',
  belowPlane: 'the camera at or below the ground',
}

// project: { demName (the terrain model's name), demDatum / poseDatum (datum labels;
//   poseDatum null = Unknown), unit (the project's height unit), breakdown ({ ok, noPose,
//   noElevation, noAngles, noSensor, belowPlane }), total (poses), fallback (the manual
//   intrinsics are complete) }
export function footprintsEffects(
  s,
  {
    demName = 'the terrain model',
    demDatum = 'unknown',
    poseDatum = null,
    unit = 'm',
    breakdown = { ok: 0 },
    total = 0,
    fallback = false,
  } = {},
) {
  const ground =
    s.ground === 'absolute'
      ? `Every corner lands on one level plane at ${s.groundElev} ${unit}.`
      : s.ground === 'agl'
        ? `Each photo's corners land on a level plane ${s.agl} ${unit} below its camera.`
        : `Each corner lands where its ray meets ${demName}; ` +
          (poseDatum == null
            ? `the camera heights are taken to be in its datum (${demDatum}).`
            : poseDatum === demDatum
              ? `the camera heights are in its datum (${demDatum}).`
              : `the camera heights are ${poseDatum}, and the terrain (${demDatum}) is converted to it.`)

  const skipped = Object.entries(REASONS)
    .filter(([k]) => breakdown[k] > 0)
    .map(([k, why]) => `${fmtCount(breakdown[k])} with ${why}`)
  const cameras = !total
    ? 'There are no camera poses: import them, or photos with GPS.'
    : `${fmtCount(breakdown.ok)} of ${plural(total, 'pose')} ${breakdown.ok === 1 ? 'gets' : 'get'} a footprint` +
      (skipped.length ? `; skipped: ${skipped.join(', ')}.` : '.') +
      (breakdown.noSensor > 0 && !fallback ? ' Fill in the manual intrinsics to place those without a sensor.' : '')
  return { ground, cameras }
}
