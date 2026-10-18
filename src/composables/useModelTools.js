import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { normalizeRegion, regionFromPositions } from '../core/products/region.js'
import { normalizeOrientation, upFromPlane } from '../core/products/orientation.js'
import { planeFromThreePoints } from '../core/products/screenPick.js'
import { matrixFromTransform } from '../core/products/cloudAlign.js'
import { estimateUpFromCameras, cameraCenter } from '../core/sfm/geometry.js'
import { useLog } from './useLog.js'

// The 3D view's editing tools, lifted out of App.vue: Tools ▸ Model ▾ ▸ Region and
// Orient model, and Point Cloud ▾ ▸ Align by point pairs. Each edits a draft in its
// floating toolbox and stores it on Apply; the picks they wait for share one
// dispatcher, so whichever tool is waiting gets the click.
//
// Injected: activateTab (useTabs), editableClouds / meshClouds (App's computed
// tool targets), runEditClouds (usePipeline — the alignment runs as a cloud edit).
export function useModelTools({ activateTab, editableClouds, meshClouds, runEditClouds }) {
  const { log } = useLog()
  const reconstructionStore = useReconstructionStore()
  const { sparseCameras, selectedCloudId } = storeToRefs(reconstructionStore)

  // Tools ▸ Model ▾ ▸ Region: the toolbox edits a draft; Apply stores it.
  const regionEdit = ref(false)
  const regionDraft = ref({ min: [0, 0, 0], max: [1, 1, 1] })
  // Fit the draft around the sparse model's points, or the dense cloud the user is
  // working on (selected, else the first computed one), ignoring the farthest 2 %.
  function fitRegionDraft(what) {
    let positions = null
    if (what === 'dense') {
      const dense = editableClouds.value.find((c) => c.id === selectedCloudId.value && !c.imported)
        ?? editableClouds.value.find((c) => !c.imported)
      positions = dense ? dense.pos.subarray(0, dense.count * 3) : null
    } else {
      const pts = reconstructionStore.mainSparseCloud?.points
      positions = pts?.length ? pts.pos.subarray(0, pts.length * 3) : new Float64Array(0)
    }
    const box = positions ? regionFromPositions(positions) : null
    if (box) regionDraft.value = box
  }
  function openRegionTool() {
    activateTab('viewer')
    const saved = normalizeRegion(reconstructionStore.region)
    if (saved && reconstructionStore.regionState.active) regionDraft.value = { min: [...saved.min], max: [...saved.max] }
    else fitRegionDraft('sparse')
    regionEdit.value = true
  }
  function applyRegion() {
    if (reconstructionStore.setRegion(regionDraft.value)) regionEdit.value = false
  }
  function removeRegion() {
    reconstructionStore.clearRegion()
    regionEdit.value = false
  }
  // ── Tools ▸ Model ▾ ▸ Orient model ─────────────────────────────────────────────
  const orientEdit = ref(false)
  const orientDraft = ref({ up: [0, 0, 1], origin: [0, 0, 0], headingDeg: 0 })
  const orientPicking = ref(null)        // null | 'plane' | 'origin'
  const orientPlanePicks = ref([])       // up to 3 picked positions
  const sparseCentre = () => {
    const pts = reconstructionStore.mainSparseCloud?.points
    if (!pts?.length) return [0, 0, 0]
    let x = 0, y = 0, z = 0
    for (const p of pts) { x += p.x; y += p.y; z += p.z }
    return [x / pts.length, y / pts.length, z / pts.length]
  }
  const cameraCentres = () => [...(reconstructionStore.mainSparseCloud?.cameras?.values() ?? [])].map((c) => cameraCenter(c))
  function openOrientTool() {
    activateTab('viewer')
    const saved = normalizeOrientation(reconstructionStore.orientation)
    orientDraft.value = saved && reconstructionStore.orientationState.active
      ? { up: [...saved.up], origin: [...saved.origin], headingDeg: saved.headingDeg }
      : { up: [...(estimateUpFromCameras(sparseCameras.value) ?? [0, 0, 1])], origin: sparseCentre(), headingDeg: 0 }
    orientPicking.value = null
    orientPlanePicks.value = []
    orientEdit.value = true
  }
  function orientPick(position) {
    if (orientPicking.value === 'origin') {
      orientDraft.value = { ...orientDraft.value, origin: position }
      orientPicking.value = null
      return
    }
    orientPlanePicks.value = [...orientPlanePicks.value, position]
    if (orientPlanePicks.value.length < 3) return
    const [a, b, c] = orientPlanePicks.value
    const plane = planeFromThreePoints(a, b, c)
    if (!plane) {
      log('Orient model: the three points are (nearly) on one line — pick a wider triangle', 'warn', 'Reconstruction')
    } else {
      const up = upFromPlane(plane.normal, plane.point, cameraCentres())
      orientDraft.value = { ...orientDraft.value, up }
    }
    orientPicking.value = null
    orientPlanePicks.value = []
  }
  function applyOrientation() {
    if (reconstructionStore.setOrientation(orientDraft.value)) orientEdit.value = false
  }
  function removeOrientation() {
    reconstructionStore.clearOrientation()
    orientEdit.value = false
  }

  // ── Tools ▸ Point Cloud ▾ ▸ Align by point pairs ───────────────────────────────
  // null, or { sourceId, referenceId, pairs: [{ src, dst|null }], allowScale }.
  const alignPairs = ref(null)
  const alignReferences = computed(() => [...editableClouds.value, ...meshClouds.value])
  function openAlignPairs() {
    activateTab('viewer')
    const sourceId = editableClouds.value.find((c) => c.id === selectedCloudId.value)?.id ?? editableClouds.value[0]?.id ?? null
    const referenceId = alignReferences.value.find((c) => c.id !== sourceId)?.id ?? null
    alignPairs.value = { sourceId, referenceId, pairs: [], allowScale: false }
  }
  function alignPick(position, cloudId) {
    const a = alignPairs.value
    const last = a.pairs[a.pairs.length - 1]
    if (last && !last.dst) {
      if (cloudId !== a.referenceId) return
      a.pairs = [...a.pairs.slice(0, -1), { ...last, dst: position }]
    } else {
      if (cloudId !== a.sourceId) return
      a.pairs = [...a.pairs, { src: position, dst: null }]
    }
  }
  async function applyAlignPairs(transform) {
    const a = alignPairs.value
    const source = editableClouds.value.find((c) => c.id === a.sourceId)
    alignPairs.value = null
    await runEditClouds({
      mode: 'transform', sourceIds: [a.sourceId],
      settings: { matrix: matrixFromTransform(transform) },
      name: `${source?.name ?? 'Cloud'} (aligned)`,
    })
  }

  // One pick dispatcher for the 3D view: whichever tool is waiting gets the click.
  const viewerPickMode = computed(() => {
    if (orientEdit.value && orientPicking.value) return {}
    const a = alignPairs.value
    if (a) {
      const last = a.pairs[a.pairs.length - 1]
      return { cloudIds: [last && !last.dst ? a.referenceId : a.sourceId].filter(Boolean) }
    }
    return null
  })
  function onViewerPick({ position, cloudId }) {
    if (orientEdit.value && orientPicking.value) orientPick(position)
    else if (alignPairs.value) alignPick(position, cloudId)
  }
  // Markers: point pairs (orange = to move, blue = reference), the ground picks
  // (green) and the chosen origin (white).
  const viewerMarkers = computed(() => {
    const out = []
    if (alignPairs.value) {
      for (const p of alignPairs.value.pairs) {
        out.push({ position: p.src, color: '#ff8c1a' })
        if (p.dst) out.push({ position: p.dst, color: '#2f9bff' })
      }
    }
    if (orientEdit.value) {
      for (const p of orientPlanePicks.value) out.push({ position: p, color: '#3ccf6e' })
      out.push({ position: orientDraft.value.origin, color: '#ffffff' })
    }
    return out
  })

  // What the 3D view draws: the draft while editing, else the saved box (dim if stale).
  const viewerRegionBox = computed(() => (regionEdit.value ? regionDraft.value : normalizeRegion(reconstructionStore.region)))
  const viewerRegionStale = computed(() => !regionEdit.value && reconstructionStore.regionState.reason === 'stale')

  // The orientation toolbox's controls.
  function toggleOrientPick(target) {
    orientPicking.value = orientPicking.value === target ? null : target
    orientPlanePicks.value = []
  }
  function orientAutoUp() {
    orientDraft.value = { ...orientDraft.value, up: [...(estimateUpFromCameras(sparseCameras.value) ?? [0, 0, 1])] }
  }
  function orientCentreOrigin() { orientDraft.value = { ...orientDraft.value, origin: sparseCentre() } }
  function setOrientHeading(h) { if (Number.isFinite(h)) orientDraft.value = { ...orientDraft.value, headingDeg: h } }

  // Escape with nothing modal open leaves the innermost active tool step: a pending
  // pick before its tool. False when no tool was active.
  function exitModelTool() {
    if (regionEdit.value) regionEdit.value = false
    else if (orientEdit.value) { if (orientPicking.value) orientPicking.value = null; else orientEdit.value = false }
    else if (alignPairs.value) alignPairs.value = null
    else return false
    return true
  }

  return {
    regionEdit, regionDraft, fitRegionDraft, openRegionTool, applyRegion, removeRegion,
    orientEdit, orientDraft, orientPicking, orientPlanePicks, openOrientTool, applyOrientation, removeOrientation,
    toggleOrientPick, orientAutoUp, orientCentreOrigin, setOrientHeading,
    alignPairs, alignReferences, openAlignPairs, applyAlignPairs,
    viewerPickMode, onViewerPick, viewerMarkers, viewerRegionBox, viewerRegionStale, exitModelTool,
  }
}
