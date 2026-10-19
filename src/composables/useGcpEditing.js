import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useImageViewSettings } from './useImageViewSettings.js'
import { useLog } from './useLog.js'
import { heightShifter } from '../core/verticalDatum.js'
import { ensureProjection, transform } from '../core/crs.js'

// Ground control in the views, lifted out of App.vue: marking GCPs in an image
// (with the model's guides and the per-mark diagnostics), placing them on the
// map, the accuracy report that feeds every GCP display, and the selection they
// share. The store owns the GCP records; this owns what the views do with them.
//
// Injected (tabs live in App.vue's useTabs): activeTab, openImageTab, openGcpTab, closeTab.
export function useGcpEditing({ activeTab, openImageTab, openGcpTab, closeTab }) {
  const { log } = useLog()
  const gcpsStore = useGcpsStore()
  const { gcps } = storeToRefs(gcpsStore)
  const { addGcp, addPoint, setGcpRole, setGcpPosition, setObservation, removeObservation, removeGcp } = gcpsStore
  const reconstructionStore = useReconstructionStore()
  const { sparseCameras } = storeToRefs(reconstructionStore)
  const { georeference, gcpAccuracyReport, gcpGuides, gcpEstimate } = reconstructionStore
  const externalStore = useExternalStore()
  const { currentCrs } = storeToRefs(useProjectsStore())
  const { scaleBarsOpen } = storeToRefs(useModalsStore())
  const { imageViewPrefs, patchImageView } = useImageViewSettings()

  // GCP elevations from an imported reference DEM (the stated goal of the
  // external-reference-data work). The sampler is *injected* rather than imported
  // so useGcpsStore keeps no dependency on the external store; it reprojects the
  // GCP's project-CRS position into the raster's native CRS (the raster itself is
  // never warped) and carries the raster's declared vertical accuracy back with
  // the value, so a filled Z can never claim an accuracy it doesn't have.
  const sampleReferenceDem = (x, y, opts) => externalStore.sampleReferenceDem(x, y, opts)

  async function fillGcpZFromReferenceDem() {
    const res = await gcpsStore.fillZFromReferenceDem(sampleReferenceDem)
    if (res.filled) refreshGcpReport()
  }

  async function checkGcpZAgainstReferenceDem() {
    await gcpsStore.checkZAgainstReferenceDem(sampleReferenceDem)
  }

  // GCP table ▸ Convert heights to…: every point's Z re-expressed in `datum`, the
  // geoid separation taken at its own position. Heights are control, so refit.
  async function convertGcpHeightsTo(datum) {
    const crs = currentCrs.value
    const shifters = new Map()
    const res = await gcpsStore.convertGcpHeights(datum, async (g, from) => {
      if (!shifters.has(from)) shifters.set(from, await heightShifter(from, datum))
      const shift = shifters.get(from)
      if (!shift || !Number.isFinite(g.x) || !Number.isFinite(g.y)) return null
      try {
        if (crs !== 'EPSG:4326') await ensureProjection(crs)
        return shift(...(crs === 'EPSG:4326' ? [g.x, g.y] : transform([g.x, g.y], crs, 'EPSG:4326')))
      } catch { return null }
    })
    if (res.converted && reconstructionStore.sparseCameras.size) await georeference()
    refreshGcpReport()
  }

  // Per-GCP accuracy report (triangulated residual vs. surveyed position + per-
  // observation reprojection error) — refreshed on demand since it triangulates
  // against the current sparse cloud; cheap enough to just re-run each open/refresh
  // and after every mark so the reprojection feedback stays live.
  const gcpReport = ref([])
  async function refreshGcpReport() {
    gcpReport.value = await gcpAccuracyReport()
  }

  async function changeGcpRole({ id, role }) {
    setGcpRole(id, role)
    // A role change alters the control set. Refit immediately so a checkpoint can
    // never be displayed against a stale transform that still used it as control.
    if (reconstructionStore.sparseCameras.size) await georeference()
    await refreshGcpReport()
  }

  // `selectedGcpId` highlights a GCP's marker in the image view + its row in the
  // table; set by clicking a GCP row (highlight only — marking is via right-click).
  const selectedGcpId = ref(null)
  // Marker currently being created by the guided scale setup. Once it has two
  // photo observations, return to the setup modal so the user can continue with
  // point 2 or enter the measured distance without hunting through the ribbon.
  const scaleSetupMarkerId = ref(null)
  function selectGcp(id) { selectedGcpId.value = id }

  // Turn on the GCP overlay so a freshly-placed mark is visible.
  function ensureGcpsVisible() {
    if (!imageViewPrefs.value.showGcps) patchImageView({ showGcps: true })
  }

  // One line per placed mark — the *only* GCP-guide logging in the app. `guide` is
  // read from activeImageGcpGuides by the caller BEFORE setObservation: marking a GCP
  // retires its guide on that image, so the prediction being compared against only
  // exists until the click lands.
  //
  // The info line reports the gap between where the model predicted the mark and
  // where the user actually clicked. That gap is the diagnostic (METHODS.md §6.4) —
  // it should shrink as marks accumulate, and a large one means the reconstruction
  // and the user disagree. Logging the guides themselves instead (on every recompute)
  // reported the app re-rendering, not the user working.
  async function logGcpMark(gcpId, imageId, imageName, px, py, guide) {
    const gcp = gcps.value.find((g) => g.id === gcpId)
    const name = gcp?.name ?? 'GCP'
    const at = `(${px.toFixed(0)}, ${py.toFixed(0)}) on ${imageName}`
    // Runs after setObservation, but this excludes the target image, so 0 still
    // means "the mark just placed is this GCP's first".
    const otherMarks = (gcp?.observations ?? [])
      .filter((o) => o.imageId !== imageId && o.px != null && o.py != null).length
    // Guides are only computed in gcpEdit mode, so an absent guide means either
    // nothing could be predicted yet, or the user is marking with guides off — say
    // which, rather than implying a prediction existed and was missed.
    if (!guide) {
      const why = otherMarks === 0 ? ' — first mark for this GCP, nothing to predict from yet' : ''
      log(`GCP "${name}" marked at ${at}${why}`, 'info', 'GCP')
    } else if (guide.kind === 'line') {
      // `line` is normalised (a²+b²=1), so |a·u+b·v+c| is a true pixel distance.
      const d = Math.abs(guide.line[0] * px + guide.line[1] * py + guide.line[2])
      log(`GCP "${name}" marked at ${at} — ${d.toFixed(1)}px off the epipolar line predicted `
        + `from its 1 other mark`, 'info', 'GCP')
    } else {
      const d = Math.hypot(guide.u - px, guide.v - py)
      const used = guide.viewCount - (guide.rejectedCount ?? 0)
      const from = guide.rejectedCount
        ? `${used} of its ${guide.viewCount} other marks (${guide.rejectedCount} inconsistent with `
          + `the rest, left out of that prediction only)`
        : `its ${guide.viewCount} other marks`
      log(`GCP "${name}" marked at ${at} — ${d.toFixed(1)}px from the position predicted by `
        + `${from}`, 'info', 'GCP')
    }
    await logGcpEstimateShift(gcpId, imageId, px, py, name, guide)
  }

  // Detail-only: proof that the new mark actually moved the model's estimate, and
  // which way. Runs AFTER setObservation, so `gcpEstimate` sees the new mark.
  //
  // `guide` (pre-mark) is the prediction from the GCP's *other* N marks; the estimate
  // after the click is fitted from all N+1. Their difference is this mark's influence
  // on where the model puts the GCP, seen on the image being worked on — the only
  // place it's observable, since the guide here retires the moment the mark lands.
  // Expect it to move toward the click and to shrink as N grows (each mark is one
  // vote of N+1). A 0.0px move with the mark counted as inconsistent is the robust
  // fit rejecting it, not a stuck estimate.
  async function logGcpEstimateShift(gcpId, imageId, px, py, name, guide) {
    if (guide?.kind !== 'point') return   // nothing predicted here before the mark
    const after = await gcpEstimate(gcpId, imageId)
    if (!after) return
    const dx = after.u - guide.u, dy = after.v - guide.v
    const moved = Math.hypot(dx, dy)
    // Sign against the click: a mark should pull the estimate toward itself.
    const toClick = Math.hypot(px - guide.u, py - guide.v)
    const towards = toClick > 1e-6 && ((px - guide.u) * dx + (py - guide.v) * dy) > 0
    const dir = moved < 0.05
      ? 'did not move the estimate (mark consistent with it, or rejected as inconsistent)'
      : `moved the estimate ${moved.toFixed(1)}px ${towards ? 'toward' : 'away from'} your click `
        + `(Δx ${dx >= 0 ? '+' : ''}${dx.toFixed(1)}, Δy ${dy >= 0 ? '+' : ''}${dy.toFixed(1)}), `
        + `now (${after.u.toFixed(1)}, ${after.v.toFixed(1)}) from ${after.viewCount} marks`
    log(`GCP "${name}": this mark ${dir}`, 'debug', 'GCP')
  }

  // Right-click marking in the image view. Assign attaches the clicked pixel to an
  // existing GCP; add-here creates a new GCP already marked at that pixel and
  // selects it. Both refresh the accuracy report so reprojection feedback is live.
  // The guide is captured before setObservation retires it; logging then runs async
  // so the mark itself stays instant.
  function assignGcpObservation(imageId, imageName, { gcpId, px, py }) {
    const guide = activeImageGcpGuides.value.find((g) => g.gcpId === gcpId)
    setObservation(gcpId, imageId, imageName, px, py)
    selectedGcpId.value = gcpId
    ensureGcpsVisible()
    refreshGcpReport()
    logGcpMark(gcpId, imageId, imageName, px, py, guide)
    const point = gcps.value.find((g) => g.id === gcpId)
    if (scaleSetupMarkerId.value === gcpId && (point?.observations?.length ?? 0) >= 2) {
      scaleSetupMarkerId.value = null
      patchImageView({ gcpEdit: false })
      scaleBarsOpen.value = true
    }
  }
  // Create a new reference point already marked at this pixel. `role` is
  // 'control' (surveyed ground control) or 'marker' (a scale-bar endpoint with no
  // surveyed position) — always chosen up front, never by creating a control point
  // and re-roling it (see useGcpsStore.addPoint).
  function addGcpAtObservation(imageId, imageName, { px, py, role = 'control' }) {
    const id = addPoint({ role })
    setObservation(id, imageId, imageName, px, py)
    selectedGcpId.value = id
    ensureGcpsVisible()
    refreshGcpReport()
    logGcpMark(id, imageId, imageName, px, py, null)  // new point — never has a guide
  }

  // ── GCP ground-position editing from the 2D map ─────────────────────────────────
  // Map coordinates are already in the project CRS (= GCP storage CRS), so a click /
  // drag sets X/Y directly. Z has no top-down axis and is left to the table.
  function setGcpGroundPosition({ id, x, y }) {
    setGcpPosition(id, 'x', x)
    setGcpPosition(id, 'y', y)
    selectedGcpId.value = id
    const g = gcps.value.find((gg) => gg.id === id)
    log(`GCP "${g?.name ?? id}" position set to (${x.toFixed(3)}, ${y.toFixed(3)}) ${currentCrs.value}`, 'info', 'GCP')
    refreshGcpReport()
  }
  function addGcpAtCoord({ x, y }) {
    const id = addGcp()
    setGcpPosition(id, 'x', x)
    setGcpPosition(id, 'y', y)
    selectedGcpId.value = id
    refreshGcpReport()
  }
  // A GCP read straight off a reference raster tab (A-5): a new control point,
  // or the selected one moved there (ProductViewer pick-gcp).
  async function pickGcpFromReference(rasterId, { col, row, displayFactor, gcpId = null }) {
    let pick
    // A moved GCP keeps its declared height datum when the DEM's converts to it.
    const datum = gcpId ? gcps.value.find((g) => g.id === gcpId)?.verticalDatum : null
    try {
      pick = await externalStore.pickGroundControl(rasterId, col, row, { displayFactor, datum })
    } catch (err) {
      log(`GCP from reference: ${err.message}`, 'warn', 'GCP')
      return
    }
    const id = gcpId ?? addGcp()
    if (!gcpsStore.setGcpFromReference(id, pick)) return
    selectedGcpId.value = id
    refreshGcpReport()
  }
  // Select a just-created point and put the image view into marking mode, so the
  // user's next click marks it. Used by the Scale Bars modal's "＋ New marker": the
  // marker exists but is useless until it is marked in ≥2 images.
  function startMarkingPoint(gcpId) {
    scaleSetupMarkerId.value = gcpId
    selectedGcpId.value = gcpId
    ensureGcpsVisible()
    patchImageView({ gcpEdit: true })
    refreshGcpReport()
  }
  function exitGcpEdit() {
    scaleSetupMarkerId.value = null
    patchImageView({ gcpEdit: false })
  }

  // Sidebar observation-list actions.
  function jumpToImage({ imageId }) { if (imageId != null) openImageTab(imageId) }

  // Double-click a GCP in the sidebar → multi-image inspector tab.
  function openGcpView(gcpId) {
    const g = gcps.value.find((x) => x.id === gcpId)
    if (g) openGcpTab(gcpId, g.name)
  }

  // Remove a GCP wherever it was asked from (sidebar, table, editor toolbars — all
  // through confirmRemoveGcp): close its inspector tab, drop the selection if it was
  // the target, and refresh reprojection feedback.
  function removeGcpAndCloseTab(gcpId) {
    removeGcp(gcpId)
    closeTab(`gcp:${gcpId}`)
    if (selectedGcpId.value === gcpId) selectedGcpId.value = null
    refreshGcpReport()
  }
  function removeGcpObservation({ gcpId, imageId }) {
    removeObservation(gcpId, imageId)
    refreshGcpReport()
  }

  // GCP observations falling on the active image tab (for marker overlay), each
  // tagged with its live reprojection error (px) from the accuracy report so the
  // viewer can flag a bad mark.
  const activeImageGcps = computed(() => {
    const tab = activeTab.value
    if (!tab || tab.type !== 'image') return []
    const out = []
    for (const g of gcps.value) {
      if (g.enabled === false) continue
      const rep = gcpReport.value.find((r) => r.gcpId === g.id)
      for (const obs of g.observations || []) {
        if (obs.imageId === tab.imageId && obs.px != null && obs.py != null) {
          const reprojPx = rep?.observations?.find((o) => o.imageId === obs.imageId)?.reprojPx ?? null
          out.push({ id: g.id, name: g.name, px: obs.px, py: obs.py, reprojPx })
        }
      }
    }
    return out
  })

  // Guided marking: for GCPs *not yet* marked on the active image, where the
  // current cloud's poses say they must lie — a predicted pixel (≥2 other
  // observations) or an epipolar line (exactly 1). Async (triangulation goes
  // through wasm), so a token drops out-of-order results; empty unless the image
  // is registered and the GCP overlay is being looked at.
  const activeImageGcpGuides = ref([])
  let guideToken = 0
  // Guides follow `gcpEdit` alone, NOT `showGcps`. They are an aiming aid for
  // *placing* a mark, so they have no purpose while merely viewing GCPs — and since
  // turning gcpEdit on force-enables showGcps (see the ribbon command), gating on
  // `showGcps || gcpEdit` left the guides drawn after the user switched editing off.
  async function refreshGcpGuides() {
    const tab = activeTab.value
    if (tab?.type !== 'image' || !imageViewPrefs.value.gcpEdit) {
      activeImageGcpGuides.value = []
      return
    }
    const token = ++guideToken
    const res = await gcpGuides(tab.imageId)
    if (token === guideToken) activeImageGcpGuides.value = res
  }
  // Two watchers below feed one refresh, and a single user action commonly trips
  // both (adding/marking a GCP mutates `gcps` *and* selects it), which ran the
  // guides twice and double-logged every line. They can't merge into one watcher:
  // a combined `deep: true` would deep-traverse `sparseCameras`. So coalesce —
  // at most one refresh per tick, after both watchers have fired.
  let guideRefreshQueued = false
  function queueGcpGuidesRefresh() {
    if (guideRefreshQueued) return
    guideRefreshQueued = true
    nextTick(() => { guideRefreshQueued = false; refreshGcpGuides() })
  }
  // Cameras change on a rebuild (`sparseCameras` is a fresh Map), so a shallow
  // watch catches it — no deep traversal of every camera's R/t/K.
  // Not selectedGcpId: the guide set doesn't depend on it (every unmarked GCP gets
  // one; selection only changes which are drawn boldly, which is ViewerImage's own
  // prop). Watching it here just recomputed the identical set on every row click.
  watch(
    [() => activeTab.value?.imageId, () => imageViewPrefs.value.gcpEdit, sparseCameras],
    queueGcpGuidesRefresh,
    { immediate: true },
  )
  // Marks mutate in place, so this one needs to be deep — it's what retires a
  // guide the moment its GCP is marked on this image.
  watch(gcps, queueGcpGuidesRefresh, { deep: true })

  // Just [{ id, name }] of every GCP — the image viewer's right-click "assign to
  // existing" submenu.
  const allGcpsBrief = computed(() => gcps.value.map((g) => ({ id: g.id, name: g.name })))

  return {
    gcpReport, refreshGcpReport, selectedGcpId, selectGcp, changeGcpRole,
    fillGcpZFromReferenceDem, checkGcpZAgainstReferenceDem, convertGcpHeightsTo,
    assignGcpObservation, addGcpAtObservation, setGcpGroundPosition, addGcpAtCoord, pickGcpFromReference,
    startMarkingPoint, exitGcpEdit, jumpToImage, openGcpView, removeGcpAndCloseTab, removeGcpObservation,
    activeImageGcps, activeImageGcpGuides, allGcpsBrief,
  }
}
