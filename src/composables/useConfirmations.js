import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'

// Confirm-before-destroy for every irreversible user action, lifted out of App.vue.
//
// Two dialogs, deliberately not merged:
//   • `pendingImageDelete` — removing images. Its own state because the message is
//     computed from a name list and the sidebar multi-select drives it.
//   • `pendingConfirm` — everything else. Holds `{ title, message, confirmLabel,
//     onConfirm }`; `askConfirm` opens it and the dialog runs `onConfirm` on accept.
//     One dialog for N destructive actions is what keeps the wording consistent.
//
// Stores are read directly (the composable convention here — see useImportRouting);
// only the tab-management callbacks are injected, since tabs live in App.vue:
//   closeTabForImage / closeTabForRaster — close a tab whose subject is going away
//   removeGcpAndCloseTab — App.vue's remove-GCP-plus-close-its-inspector-tab
export function useConfirmations({ closeTabForImage, closeTabForRaster, removeGcpAndCloseTab }) {
  const imagesStore = useImagesStore()
  const { imageById, removeImage, clearKeypoints } = imagesStore
  const { sensors } = storeToRefs(useSensorsStore())
  const { removeSensor } = useSensorsStore()
  const matchesStore = useMatchesStore()
  const { matchStore } = storeToRefs(matchesStore)
  const { clouds } = storeToRefs(useReconstructionStore())
  const { removeCloud } = useReconstructionStore()
  const externalStore = useExternalStore()
  const { gcps } = storeToRefs(useGcpsStore())
  const footprintsStore = useFootprintsStore()
  const { sets: shapefiles } = storeToRefs(footprintsStore)

  // ── Image removal ───────────────────────────────────────────────────────────
  const pendingImageDelete = ref(null)

  function requestRemoveImages(idOrIds) {
    const ids = (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).filter(Boolean)
    if (!ids.length) return
    const names = ids.map((id) => imageById(id)?.name).filter(Boolean)
    pendingImageDelete.value = { ids, names }
  }

  function confirmRemoveImages() {
    const ids = pendingImageDelete.value?.ids ?? []
    for (const id of ids) removeImage(id, closeTabForImage)
    pendingImageDelete.value = null
  }

  const deleteMessage = computed(() => {
    const p = pendingImageDelete.value
    if (!p) return ''
    if (p.ids.length === 1) return `Remove “${p.names[0] ?? 'this image'}”? This also deletes its keypoints, mask, depth map and matches. This can't be undone.`
    return `Remove ${p.ids.length} images? This also deletes their keypoints, masks, depth maps and matches. This can't be undone.`
  })

  // ── Generic confirm-before-delete (sidebar removals) ────────────────────────
  const pendingConfirm = ref(null)
  function askConfirm(opts) { pendingConfirm.value = opts }
  function runPendingConfirm() {
    const fn = pendingConfirm.value?.onConfirm
    pendingConfirm.value = null
    fn?.()
  }

  function confirmRemoveSensor(id) {
    const s = sensors.value.find((x) => x.id === id)
    askConfirm({
      title: 'Remove sensor?',
      message: `Remove sensor “${s?.label ?? id}”? Images assigned to it will be left without a sensor.`,
      onConfirm: () => removeSensor(id),
    })
  }

  function confirmRemoveCloud(id) {
    const c = clouds.value.find((x) => x.id === id)
    askConfirm({
      title: 'Remove cloud?',
      message: `Remove “${c?.name ?? 'this cloud'}”? This can't be undone.`,
      onConfirm: () => removeCloud(id),
    })
  }

  function confirmRemoveRaster(id) {
    const r = externalStore.rasterById(id)
    askConfirm({
      title: 'Remove reference raster?',
      message: `Remove “${r?.name ?? 'this raster'}”? The imported file is deleted from the project. This can't be undone.`,
      onConfirm: async () => {
        closeTabForRaster(id)
        await externalStore.removeRaster(id)
      },
    })
  }

  function confirmRemoveGcp(id) {
    const g = gcps.value.find((x) => x.id === id)
    askConfirm({
      title: 'Remove GCP?',
      message: `Remove GCP “${g?.name ?? id}” and all its image observations? This can't be undone.`,
      onConfirm: () => removeGcpAndCloseTab(id),
    })
  }

  function confirmRemoveShapefile(id) {
    const set = shapefiles.value.find((s) => s.id === id)
    askConfirm({
      title: 'Remove shapefile?',
      message: `Remove “${set?.name ?? 'this layer'}” and its ${set?.footprints.length ?? 0} polygon(s)? This can't be undone.`,
      onConfirm: () => footprintsStore.removeSet(id),
    })
  }

  function confirmClearKeypoints(idOrIds) {
    const ids = (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).filter(Boolean)
    if (!ids.length) return
    const msg = ids.length === 1
      ? `Delete keypoints for “${imageById(ids[0])?.name ?? 'this image'}”? Its matches are dropped too and it must be re-detected before matching.`
      : `Delete keypoints for ${ids.length} images? Their matches are dropped too and they must be re-detected before matching.`
    askConfirm({
      title: 'Delete keypoints?',
      message: msg,
      confirmLabel: 'Delete',
      onConfirm: () => ids.forEach((id) => clearKeypoints(id)),
    })
  }

  function confirmRemoveMatches() {
    const count = matchStore.value.size
    if (!count) return
    askConfirm({
      title: 'Remove matches?',
      message: `Remove all ${count.toLocaleString()} match pair${count === 1 ? '' : 's'}? Existing sparse clouds are kept, but reconstruction cannot be rerun until the images are matched again. This can't be undone.`,
      confirmLabel: 'Remove',
      onConfirm: () => matchesStore.clear({ purge: true }),
    })
  }

  return {
    pendingImageDelete, requestRemoveImages, confirmRemoveImages, deleteMessage,
    pendingConfirm, askConfirm, runPendingConfirm,
    confirmRemoveSensor, confirmRemoveCloud, confirmRemoveRaster,
    confirmRemoveGcp, confirmRemoveShapefile, confirmClearKeypoints, confirmRemoveMatches,
  }
}
