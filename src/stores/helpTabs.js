// The tab actions the Guide and the Glossary share (useGuideStore, useGlossaryStore):
// their tabs are plain ids after a fixed Home tab, and the strip reorders and closes
// them as the workspace's tabs do (composables/useTabs.js).
//   tabs      — Ref<string[]>, in strip order
//   activeId  — Ref<string>, 'home' or one of the ids
//   setActive — the store's own, so the guide also drops its section focus
export function helpTabActions({ tabs, activeId, setActive }) {
  // Dropping onto a tab to the right lands after it; to the left, before it.
  function moveTab(draggedId, targetId) {
    if (draggedId === targetId) return
    const arr = [...tabs.value]
    const from = arr.indexOf(draggedId)
    const to = arr.indexOf(targetId)
    if (from < 0 || to < 0) return
    arr.splice(from, 1)
    const target = arr.indexOf(targetId)
    arr.splice(from < to ? target + 1 : target, 0, draggedId)
    tabs.value = arr
  }

  // Keep `id` and close the tabs `drop(i, idx)` picks; the active tab, once closed,
  // gives way to `id`.
  function closeWhere(id, drop) {
    const idx = tabs.value.indexOf(id)
    if (idx < 0) return
    tabs.value = tabs.value.filter((t, i) => !drop(i, idx))
    if (activeId.value !== 'home' && !tabs.value.includes(activeId.value)) setActive(id)
  }
  const closeOtherTabs = (id) => closeWhere(id, (i, idx) => i !== idx)
  const closeTabsToLeft = (id) => closeWhere(id, (i, idx) => i < idx)
  const closeTabsToRight = (id) => closeWhere(id, (i, idx) => i > idx)

  function closeAllTabs() {
    tabs.value = []
    setActive('home')
  }

  return { moveTab, closeOtherTabs, closeTabsToLeft, closeTabsToRight, closeAllTabs }
}
