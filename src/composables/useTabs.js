import { ref, computed } from 'vue'

const VIEWER_TAB = { id: 'viewer', type: 'viewer', title: '3D', closable: false }
const MAP_TAB    = { id: 'map',    type: 'map',    title: '2D', closable: false }

export function useTabs(imageById) {
  const tabs = ref([{ ...VIEWER_TAB }, { ...MAP_TAB }])
  const activeTabId = ref('viewer')

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
        showKeypoints: img?.kpStatus === 'done',
        maskMode: 'none',
        brushRadius: 20,
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

  // Called after detection so open image tabs auto-show keypoints.
  function onImageDetected(imageId) {
    for (const tab of tabs.value) {
      if (tab.imageId === imageId) tab.showKeypoints = true
    }
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
    openMetadataTab,
    closeTab,
    closeTabForImage,
    onImageDetected,
    resetToViewer,
  }
}
