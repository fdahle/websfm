import { ref, computed, watch } from 'vue'

const VIEWER_TAB = { id: 'viewer', type: 'viewer', title: '3D', closable: false }
const MAP_TAB    = { id: 'map',    type: 'map',    title: '2D', closable: false }

// showMap: Ref<boolean> — when false the 2D tab is hidden and map view redirects to viewer
export function useTabs(imageById, showMap) {
  const tabs = ref([{ ...VIEWER_TAB }, { ...MAP_TAB }])
  const activeTabId = ref('viewer')

  // When map becomes unavailable (scene type change), remove the tab and redirect
  watch(showMap || ref(true), (visible) => {
    if (!visible) {
      tabs.value = tabs.value.filter((t) => t.id !== 'map')
      if (activeTabId.value === 'map') activeTabId.value = 'viewer'
    } else if (!tabs.value.some((t) => t.id === 'map')) {
      tabs.value.splice(1, 0, { ...MAP_TAB })
    }
  })

  // Overlay + edit toggles are NOT per-tab — they live in useImageViewSettings as one
  // global, localStorage-persisted preference the image view reads directly. A tab is
  // just an image reference.

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) || null)

  const activeImageTab = computed(() => {
    const tab = activeTab.value
    return tab?.type === 'image' ? imageById(tab.imageId) : null
  })

  const activeView = computed(() => {
    if (activeTabId.value === 'viewer')   return 'viewer'
    if (activeTabId.value === 'map')      return 'map'
    if (activeTabId.value === 'metadata') return 'table'
    return ''
  })

  function activateTab(id) {
    activeTabId.value = id
  }

  function openImageTab(imageId, imageName) {
    const tabId = `img:${imageId}`
    if (!tabs.value.some((t) => t.id === tabId)) {
      const img = imageById(imageId)
      tabs.value.push({
        id: tabId,
        type: 'image',
        title: imageName ?? img?.name ?? imageId,
        imageId,
        closable: true,
      })
    }
    activeTabId.value = tabId
  }

  function openMatchTab(pairId, imgIdA, imgIdB, nameA, nameB) {
    const tabId = `match:${pairId}`
    if (!tabs.value.some((t) => t.id === tabId)) {
      tabs.value.push({
        id: tabId,
        type: 'match',
        title: `${nameA.replace(/\.[^.]+$/, '')} ↔ ${nameB.replace(/\.[^.]+$/, '')}`,
        pairId,
        imageIdA: imgIdA,
        imageIdB: imgIdB,
        closable: true,
      })
    }
    activeTabId.value = tabId
  }

  // Open a multi-image GCP inspector (one panel per observation, zoomed to the
  // marked pixel). One tab per GCP; re-opening focuses the existing tab.
  function openGcpTab(gcpId, gcpName) {
    const tabId = `gcp:${gcpId}`
    if (!tabs.value.some((t) => t.id === tabId)) {
      tabs.value.push({
        id: tabId,
        type: 'gcp',
        title: gcpName ? `GCP ${gcpName}` : 'GCP',
        gcpId,
        closable: true,
      })
    }
    activeTabId.value = tabId
  }

  function openMetadataTab() {
    if (!tabs.value.some((t) => t.id === 'metadata')) {
      tabs.value.push({ id: 'metadata', type: 'table', title: 'Metadata', closable: true })
    }
    activeTabId.value = 'metadata'
  }

  // Open a raster product (DEM / orthophoto) in its own tab, like an image.
  // One tab per kind; re-opening focuses the existing tab.
  function openProductTab(kind) { // 'dem' | 'ortho'
    const tabId = `product:${kind}`
    if (!tabs.value.some((t) => t.id === tabId)) {
      tabs.value.push({
        id: tabId,
        type: 'product',
        productKind: kind,
        title: kind === 'ortho' ? 'Orthophoto' : 'DEM',
        closable: true,
      })
    }
    activeTabId.value = tabId
  }

  function closeTab(id) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx === -1 || !tabs.value[idx].closable) return
    const wasActive = activeTabId.value === id
    tabs.value.splice(idx, 1)
    if (wasActive) {
      const next = tabs.value[idx] || tabs.value[idx - 1] || tabs.value[0]
      activeTabId.value = next ? next.id : 'viewer'
    }
  }

  function closeTabForImage(imageId) {
    closeTab(`img:${imageId}`)
  }

  // Drag-reorder a closable tab next to another closable tab. Fixed tabs
  // (3D/2D, `closable: false`) stay pinned to the left and never move.
  function moveTab(draggedId, targetId) {
    if (draggedId === targetId) return
    const arr = [...tabs.value]
    const from = arr.findIndex((t) => t.id === draggedId)
    const to = arr.findIndex((t) => t.id === targetId)
    if (from < 0 || to < 0 || !arr[from].closable || !arr[to].closable) return
    const [moved] = arr.splice(from, 1)
    const target = arr.findIndex((t) => t.id === targetId)
    // Dropping onto a tab to the right lands after it; to the left, before it.
    arr.splice(from < to ? target + 1 : target, 0, moved)
    tabs.value = arr
  }

  // Bulk close operations for the tab context menu. All operate on closable tabs
  // only; fixed tabs are always kept. `id` is the right-clicked tab.
  function keepActiveValid(fallbackId) {
    if (!tabs.value.some((t) => t.id === activeTabId.value)) {
      activeTabId.value = fallbackId && tabs.value.some((t) => t.id === fallbackId)
        ? fallbackId
        : (tabs.value[0]?.id ?? 'viewer')
    }
  }

  function closeAllTabs() {
    tabs.value = tabs.value.filter((t) => !t.closable)
    keepActiveValid()
  }

  function closeOtherTabs(id) {
    tabs.value = tabs.value.filter((t) => !t.closable || t.id === id)
    activeTabId.value = id
  }

  function closeTabsToLeft(id) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    tabs.value = tabs.value.filter((t, i) => !t.closable || i >= idx)
    keepActiveValid(id)
  }

  function closeTabsToRight(id) {
    const idx = tabs.value.findIndex((t) => t.id === id)
    if (idx < 0) return
    tabs.value = tabs.value.filter((t, i) => !t.closable || i <= idx)
    keepActiveValid(id)
  }

  function resetToViewer() {
    tabs.value = tabs.value.filter((t) => !t.closable)
    activeTabId.value = 'viewer'
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    activeImageTab,
    activeView,
    activateTab,
    openImageTab,
    openMatchTab,
    openGcpTab,
    openMetadataTab,
    openProductTab,
    closeTab,
    closeTabForImage,
    moveTab,
    closeAllTabs,
    closeOtherTabs,
    closeTabsToLeft,
    closeTabsToRight,
    resetToViewer,
  }
}
