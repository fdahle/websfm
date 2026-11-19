import { watch } from 'vue'
import { recalledTabs, rememberTabs, tabsToRemember } from '../core/startupMemory.js'

// The tabs each project had open (images, GCPs, DEMs and orthophotos, reference rasters),
// kept in this browser and opened again with the project: after a reload, an update, or
// a switch to another project and back. What is kept, and how much, is
// core/startupMemory.js; a tab whose image, GCP or raster is gone is skipped.
//
// useTabMemory({ tabs, activeTabId, activateTab, currentProjectId, projectIds,
//   projectLoading, reopen }) → { restoreTabs(projectId) }
//   reopen({ type, id })  opens one kept tab through the app's own opener (which knows
//                         whether its target still exists)
//   projectLoading        nothing is saved while a project loads: the reset to the 3D
//                         tab that opening starts with is not what the user left open
const KEY = 'websfm.ui.tabs'

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}')
  } catch {
    return {}
  }
}

export function useTabMemory({ tabs, activeTabId, activateTab, currentProjectId, projectIds, projectLoading, reopen }) {
  watch(
    [tabs, activeTabId],
    () => {
      const id = currentProjectId.value
      if (!id || projectLoading.value) return
      try {
        const all = rememberTabs(readAll(), id, tabsToRemember(tabs.value, activeTabId.value), projectIds.value)
        localStorage.setItem(KEY, JSON.stringify(all))
      } catch {
        // Storage blocked or full: the tabs are not kept this time.
      }
    },
    { deep: true },
  )

  function restoreTabs(projectId) {
    const kept = recalledTabs(readAll(), projectId)
    if (!kept || projectId !== currentProjectId.value) return
    for (const tab of kept.tabs) reopen(tab)
    activateTab(tabs.value.some((t) => t.id === kept.active) ? kept.active : 'viewer')
  }

  return { restoreTabs }
}
