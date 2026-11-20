// How close the registered photos came to the correspondence floor
// (minMatchesForRegistration): a photo that registered with barely more 3D points than PnP
// needs is one any small change upstream (matching, triangulation) can cost, and when other
// photos register through it, a whole part of the scene goes with it. ETH3D playground had
// half its photos hanging on one that registered with 34 correspondences against a floor of
// 20; a sampling change in 0.8 pushed it under and 19 of 38 cameras were left.
//
// summarizeMargin(photos, { floor, factor }) → the summary's `registrationMargin`:
//   { floor, factor, registered, nearFloor, nearest: [{ name, correspondences }] }
// where nearFloor counts photos registered with fewer than factor × floor correspondences
// (nearest first, at most `keep`). describeMargin(summary) → the log line, or null.
export function summarizeMargin(photos, { floor, factor = 2, keep = 10 }) {
  const limit = factor * floor
  const near = photos.filter((p) => p.correspondences < limit).sort((a, b) => a.correspondences - b.correspondences)
  return {
    floor,
    factor,
    registered: photos.length,
    nearFloor: near.length,
    nearest: near.slice(0, keep).map((p) => ({ name: p.name, correspondences: p.correspondences })),
  }
}

export function describeMargin(m) {
  if (!m?.nearFloor) return null
  const list = m.nearest.map((p) => `${p.name} (${p.correspondences})`).join(', ')
  const more = m.nearFloor > m.nearest.length ? `, and ${m.nearFloor - m.nearest.length} more` : ''
  return (
    `${m.nearFloor.toLocaleString('en')} of ${m.registered.toLocaleString('en')} photos registered with fewer than ` +
    `${(m.factor * m.floor).toLocaleString('en')} correspondences (${m.factor}× the floor of ` +
    `${m.floor.toLocaleString('en')}): ${list}${more}. A small change in matching can leave ` +
    `them, and the photos registered through them, out`
  )
}
