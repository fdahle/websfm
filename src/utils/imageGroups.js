// Image groups: user-named folders in the sidebar's image list.
//
// A group is a VIEW over the image list and nothing else. The pipeline never
// reads it: detection, matching and SfM receive images, never groups, and the
// stored image order is untouched (sequential matching reads that order as
// capture order). Sensors are the grouping that DOES change the solve — shared
// intrinsics — so the two stay separate concepts, the same split as Metashape's
// camera groups vs. calibration groups.
//
// On disk: `project.json.imageGroups = [{ id, name, collapsed }]` (list order is
// display order) plus a per-image `groupId`. Absent ⇒ no groups / ungrouped. An
// image whose `groupId` names no group is shown ungrouped.

// Validate a persisted group list: drop malformed or duplicate entries rather
// than fail the project open over a display preference.
export function normalizeImageGroups(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const g of raw) {
    if (!g || typeof g.id !== 'string' || !g.id || seen.has(g.id)) continue
    seen.add(g.id)
    const name = typeof g.name === 'string' && g.name.trim() ? g.name.trim() : 'Group'
    out.push({ id: g.id, name, collapsed: !!g.collapsed })
  }
  return out
}

// Split the image list into display sections: one per group in group order
// (empty groups included, so a fresh group is a visible drop target), then the
// ungrouped images as `group: null`. Within a section images keep list order.
export function groupImageSections(images, groups) {
  const byGroup = new Map(groups.map((g) => [g.id, []]))
  const ungrouped = []
  for (const img of images) {
    const bucket = img.groupId != null ? byGroup.get(img.groupId) : null
    if (bucket) bucket.push(img)
    else ungrouped.push(img)
  }
  return [
    ...groups.map((g) => ({ group: g, images: byGroup.get(g.id) })),
    { group: null, images: ungrouped },
  ]
}

// "Group 1", "Group 2", … — the first number no existing group uses.
export function nextGroupName(groups, base = 'Group') {
  const used = new Set(groups.map((g) => g.name))
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
}

// Move the entry `id` by `delta` places, clamped to the list. Returns a new
// array, or null when nothing moves.
export function moveListEntry(list, id, delta) {
  const from = list.findIndex((g) => g.id === id)
  if (from < 0) return null
  const to = Math.max(0, Math.min(list.length - 1, from + delta))
  if (to === from) return null
  const next = list.slice()
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}
