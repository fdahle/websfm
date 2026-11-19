// The Points toolbox's list (components/viewers/GcpToolbar.vue): the project's
// points in role groups, control first, each in the project's order. On the map a
// click sets a ground position, which a marker does not have, so there the markers
// are left out and counted instead.
//
// Pure: plain data in, plain data out.

export const POINT_ROLES = ['control', 'check', 'marker']
const roleOf = (g) => (POINT_ROLES.includes(g?.role) ? g.role : 'control')

/**
 * @param {{ id: string, role?: string }[]} points
 * @param {{ onMap?: boolean }} [opts]
 * @returns {{ groups: { role: string, items: object[] }[], hiddenMarkers: number }}
 */
export function pointGroups(points, { onMap = false } = {}) {
  const groups = POINT_ROLES.filter((role) => !(onMap && role === 'marker'))
    .map((role) => ({ role, items: points.filter((g) => roleOf(g) === role) }))
    .filter((grp) => grp.items.length)
  const hiddenMarkers = onMap ? points.filter((g) => roleOf(g) === 'marker').length : 0
  return { groups, hiddenMarkers }
}
