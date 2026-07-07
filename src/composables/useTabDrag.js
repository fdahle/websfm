import { ref, computed } from 'vue'

// Tab drag-reorder + right-click context menu. Injected deps:
//   tabs:    Ref<Array>  — the tab list (from useTabs)
//   moveTab: function    — reorder callback (from useTabs)
export function useTabDrag({ tabs, moveTab }) {
  const draggedTabId = ref(null)
  const dragOverTabId = ref(null)

  function onTabDragStart(e, tab) {
    if (!tab.closable) { e.preventDefault(); return }
    draggedTabId.value = tab.id
    e.dataTransfer.effectAllowed = 'move'
  }
  function onTabDragOver(e, tab) {
    if (!draggedTabId.value || !tab.closable) return
    e.preventDefault()
    dragOverTabId.value = tab.id
  }
  function onTabDrop(tab) {
    if (draggedTabId.value && tab.closable) moveTab(draggedTabId.value, tab.id)
    draggedTabId.value = null
    dragOverTabId.value = null
  }
  function onTabDragEnd() {
    draggedTabId.value = null
    dragOverTabId.value = null
  }

  // Right-click context menu for closable tabs: { x, y, id }.
  const tabCtx = ref(null)
  function onTabRightClick(e, tab) {
    if (!tab.closable) return
    e.preventDefault()
    const menuW = 150, menuH = 132
    tabCtx.value = {
      x: Math.min(e.clientX, window.innerWidth - menuW),
      y: Math.min(e.clientY, window.innerHeight - menuH),
      id: tab.id,
    }
  }
  function closeTabCtx() { tabCtx.value = null }
  // Are there any closable tabs to the left / right of the menu target?
  const tabCtxHasLeft = computed(() => {
    if (!tabCtx.value) return false
    const idx = tabs.value.findIndex((t) => t.id === tabCtx.value.id)
    return tabs.value.some((t, i) => t.closable && i < idx)
  })
  const tabCtxHasRight = computed(() => {
    if (!tabCtx.value) return false
    const idx = tabs.value.findIndex((t) => t.id === tabCtx.value.id)
    return tabs.value.some((t, i) => t.closable && i > idx)
  })
  const tabCtxHasOthers = computed(() =>
    tabCtx.value ? tabs.value.some((t) => t.closable && t.id !== tabCtx.value.id) : false
  )

  return {
    draggedTabId, dragOverTabId,
    onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
    tabCtx, onTabRightClick, closeTabCtx,
    tabCtxHasLeft, tabCtxHasRight, tabCtxHasOthers,
  }
}
