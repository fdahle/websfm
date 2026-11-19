// What WebSfM opens when it starts, and the tabs each project keeps between visits.
// Pure: the composables (useProjectLifecycle, useTabMemory) read and write the browser's
// storage and hand the values in.

/**
 * What to show on start.
 *   openLast      Settings ▸ General ▸ On start: open the last project
 *   lastId        the project open when WebSfM last ran, or null
 *   projectIds    the projects in this browser
 *   interruptedId a project whose opening never finished (the tab crashed or was closed
 *                 while it loaded), or null: it is not opened again unasked, so a project
 *                 that crashes the tab cannot lock the user out
 * → { action: 'new' } | { action: 'picker', reason? , id? } | { action: 'open', id }
 */
export function startupChoice({ openLast, lastId, projectIds, interruptedId = null }) {
  if (!projectIds.length) return { action: 'new' }
  if (!openLast) return { action: 'picker' }
  if (interruptedId && projectIds.includes(interruptedId))
    return { action: 'picker', reason: 'interrupted', id: interruptedId }
  if (!lastId || !projectIds.includes(lastId)) return { action: 'picker' }
  return { action: 'open', id: lastId }
}

// The tabs a project remembers, by type: the field of the tab that names what it shows.
// Tab ids are `<prefix>:<id>` (useTabs). The 3D and 2D tabs are always there.
export const REMEMBERED_TABS = {
  image: { field: 'imageId', prefix: 'img' },
  gcp: { field: 'gcpId', prefix: 'gcp' },
  product: { field: 'productId', prefix: 'product' },
  raster: { field: 'rasterId', prefix: 'raster' },
}
const FIXED_TABS = ['viewer', 'map']
// Projects remembered at most; the least recently saved are dropped first.
export const MAX_REMEMBERED_PROJECTS = 50

/** The open tabs, as kept: [{ type, id }] in order, and the active tab's id. */
export function tabsToRemember(tabs, activeId) {
  const kept = []
  for (const t of tabs) {
    const rule = REMEMBERED_TABS[t.type]
    if (rule && t[rule.field] != null) kept.push({ type: t.type, id: String(t[rule.field]) })
  }
  const ids = new Set([...FIXED_TABS, ...kept.map(tabId)])
  return { tabs: kept, active: ids.has(activeId) ? activeId : 'viewer' }
}

/** The tab id a kept entry opens as. */
export function tabId({ type, id }) {
  return `${REMEMBERED_TABS[type].prefix}:${id}`
}

/**
 * `all` with `projectId`'s tabs set to `entry`, keeping only projects in `knownIds`
 * and the most recent MAX_REMEMBERED_PROJECTS. Returns a new object.
 */
export function rememberTabs(all, projectId, entry, knownIds) {
  const known = new Set(knownIds)
  const others = Object.entries(all && typeof all === 'object' ? all : {}).filter(
    ([id]) => id !== projectId && known.has(id),
  )
  const kept = [...others.slice(-(MAX_REMEMBERED_PROJECTS - 1)), [projectId, entry]]
  return Object.fromEntries(kept)
}

/** `projectId`'s kept tabs from `all` (as stored, maybe malformed), or null. */
export function recalledTabs(all, projectId) {
  const entry = all && typeof all === 'object' ? all[projectId] : null
  if (!entry || !Array.isArray(entry.tabs)) return null
  const tabs = entry.tabs.filter((t) => t && REMEMBERED_TABS[t.type] && typeof t.id === 'string')
  return { tabs, active: typeof entry.active === 'string' ? entry.active : 'viewer' }
}
