import { nextGroupName, moveListEntry } from '../../utils/imageGroups.js'

// Image groups (display-only folders, utils/imageGroups.js), split out of
// useImagesStore. Every mutation is a reversible user edit, so it logs on the
// activity channel and re-persists project.json.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createImageGroups({
  imageGroups, images, isPersisting, log, save,
}) {
  // ── Image groups ──────────────────────────────────────────────────────────
  // Display-only folders (utils/imageGroups.js). Every mutation is a reversible
  // user edit, so it logs on the activity channel and re-persists project.json.
  function persistGroups() { if (isPersisting()) save() }
  function groupById(id) { return imageGroups.value.find((g) => g.id === id) || null }

  // Create a group, optionally filling it. `id` may be supplied by the caller
  // (the sidebar picks it so it can start an inline rename on the new row).
  // A NAMED group asked for without an id (an action's own group, e.g. Image
  // Quality's "Low image quality") is reused when one of that name exists: the
  // images move into it, rather than every click stacking up another, emptied one.
  function createImageGroup({ id, name, imageIds = [] } = {}) {
    const trimmed = name?.trim()
    if (id == null && trimmed) {
      const existing = imageGroups.value.find((g) => g.name === trimmed)
      if (existing) { setImagesGroup(imageIds, existing.id); return existing }
    }
    id ??= crypto.randomUUID()
    if (groupById(id)) return null
    const group = { id, name: trimmed || nextGroupName(imageGroups.value), collapsed: false }
    imageGroups.value.push(group)
    const moved = assignGroup(imageIds, id)
    log(`Created image group "${group.name}"${moved ? ` with ${moved} image${moved !== 1 ? 's' : ''}` : ''}`,
      'info', 'Images', { channel: 'activity' })
    persistGroups()
    return group
  }

  function renameImageGroup(id, name) {
    const group = groupById(id)
    const trimmed = name?.trim()
    if (!group || !trimmed || trimmed === group.name) return false
    const previous = group.name
    group.name = trimmed
    log(`Renamed image group "${previous}" → "${trimmed}"`, 'info', 'Images', { channel: 'activity' })
    persistGroups()
    return true
  }

  // Removing a group never removes images: its members become ungrouped.
  function removeImageGroup(id) {
    const group = groupById(id)
    if (!group) return false
    let freed = 0
    for (const img of images.value) if (img.groupId === id) { img.groupId = null; freed++ }
    imageGroups.value = imageGroups.value.filter((g) => g.id !== id)
    log(`Removed image group "${group.name}"${freed ? ` (${freed} image${freed !== 1 ? 's' : ''} now ungrouped)` : ''}`,
      'info', 'Images', { channel: 'activity' })
    persistGroups()
    return true
  }

  function assignGroup(imageIds, groupId) {
    const ids = new Set(imageIds)
    let moved = 0
    for (const img of images.value) {
      if (!ids.has(img.id) || (img.groupId ?? null) === groupId) continue
      img.groupId = groupId
      moved++
    }
    return moved
  }

  // Move images into a group, or out of every group with `groupId: null`.
  function setImagesGroup(imageIds, groupId) {
    const target = groupId == null ? null : groupById(groupId)
    if (groupId != null && !target) return 0
    const moved = assignGroup(imageIds, target?.id ?? null)
    if (!moved) return 0
    const what = `${moved} image${moved !== 1 ? 's' : ''}`
    log(target ? `Moved ${what} to group "${target.name}"` : `Removed ${what} from their group`,
      'info', 'Images', { channel: 'activity' })
    persistGroups()
    return moved
  }

  // Collapse state is persisted view state (like a raster's `visible` flag): a 342-image
  // project should reopen the way it was left. Not worth an activity line.
  function setImageGroupCollapsed(id, collapsed) {
    const group = groupById(id)
    if (!group || group.collapsed === !!collapsed) return
    group.collapsed = !!collapsed
    persistGroups()
  }

  function moveImageGroup(id, delta) {
    const next = moveListEntry(imageGroups.value, id, delta)
    if (!next) return false
    imageGroups.value = next
    persistGroups()
    return true
  }

  return {
    persistGroups, groupById, createImageGroup, renameImageGroup, removeImageGroup, assignGroup,
    setImagesGroup, setImageGroupCollapsed, moveImageGroup,
  }
}
