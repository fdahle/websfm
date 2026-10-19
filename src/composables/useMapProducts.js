import { computed, ref, shallowRef, watch } from 'vue'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { PRODUCT_KINDS, placeProductLayer, productLabel } from '../core/products/productLayers.js'
import { MODEL_MAP_CRS, modelMapCameras, modelMapExtent } from '../core/products/modelMap.js'
import { frameFromSpec } from '../core/products/frameSpec.js'
import { createProductRasterSource } from '../core/io/rasterSource.js'
import { transform } from '../core/crs.js'
import { demRef } from '../core/products/demWindow.js'
import { readDemWindow } from '../workers/computeClient.js'

// What the 2D map shows, in which frame (CLAUDE.md ▸ map raster layers).
//
// Two frames. The CRS map is the project CRS: basemap, GPS, GCPs, footprints,
// reference rasters and CRS products. The MODEL map is a top-down view of the
// sparse model's local frame — the same frame local products are built in — for
// a project with no CRS position: camera centres and local products, nothing else.
// The user picks with View ▸ Map ▸ Model Frame; until they do, the map uses the
// model frame only when a sparse model exists and nothing could be placed in a CRS.
//
// Raster layer list order is draw order, bottom first, so computed products draw
// above the reference data they are usually compared against.

// The user's explicit choice ('crs' | 'model'), null = automatic. Session-scoped
// and shared by every caller, like the other map view toggles.
const frameChoice = ref(null)
// The layer the map's Measure tools run against (a layer id), null = automatic.
const measureChoice = ref(null)

export function useMapProducts() {
  const recon = useReconstructionStore()
  const external = useExternalStore()
  const projects = useProjectsStore()
  const imagesStore = useImagesStore()
  const posesStore = usePosesStore()
  const gcpsStore = useGcpsStore()

  const productOf = (kind) => (kind === 'dem' ? recon.dem : recon.ortho)
  const hasModel = computed(() => !!recon.mainSparseCloud?.cameras?.size)

  // Anything with a CRS position: a georeference, GPS, imported poses, GCPs with
  // coordinates, or an on-map reference raster.
  const hasCrsContent = computed(() => recon.currentFrameSignature?.source === 'georef'
    || imagesStore.images.some((img) => img.meta?.gpsLat != null)
    || posesStore.poses.some((p) => p.enabled !== false)
    || gcpsStore.gcps.some((g) => Number.isFinite(g.x) && Number.isFinite(g.y))
    || external.mapRasters.length > 0)

  const mode = computed(() => {
    if (!hasModel.value) return 'crs'
    if (frameChoice.value) return frameChoice.value
    return hasCrsContent.value ? 'crs' : 'model'
  })
  function toggleModelFrame() {
    frameChoice.value = mode.value === 'model' ? 'crs' : 'model'
  }

  // The map's local frame, resolved through THE resolver (effectiveFrameSpec, as
  // every product is) and rebuilt exactly as the products worker would build it
  // (frameSpec.js). Async because the resolver is; a token drops stale answers.
  const modelFrame = shallowRef(null) // { frame, unit } | null
  let token = 0
  watch([() => recon.mainSparseCloud, () => recon.currentFrameSignature, () => recon.orientation], async () => {
    const t = ++token
    const cloud = recon.mainSparseCloud
    if (!cloud?.cameras?.size) { modelFrame.value = null; return }
    try {
      const resolved = await recon.effectiveFrameSpec({ crs: 'local' })
      if (t !== token) return
      const frame = frameFromSpec(resolved.frameSpec, [...cloud.cameras.values()], cloud.points ?? [])
      modelFrame.value = { frame, unit: resolved.unit === 'm' ? 'm' : 'model units' }
    } catch {
      if (t === token) modelFrame.value = null
    }
  }, { immediate: true })

  // Registered camera centres in the model frame (the model map's only vectors).
  const modelCameras = computed(() => {
    const f = modelFrame.value?.frame
    const cloud = recon.mainSparseCloud
    if (!f || !cloud?.cameras) return []
    const byUuid = new Map(imagesStore.images.map((img) => [img.uuid, img]))
    const cams = []
    for (const [uuid, cam] of cloud.cameras) {
      const img = byUuid.get(uuid)
      cams.push({ imageId: img?.id ?? null, imageName: img?.name ?? uuid.slice(0, 8), R: cam.R, t: cam.t })
    }
    return modelMapCameras(cams, f)
  })

  // The model map's viewer frame: its projection code, unit label and extent.
  // The extent comes from the cameras only, so toggling a layer never rebuilds the
  // map; its generous padding covers every product of the same model. `key`
  // changes exactly when the map must be rebuilt.
  const mapFrame = computed(() => {
    if (mode.value !== 'model' || !modelFrame.value) return null
    const extent = modelMapExtent(modelCameras.value)
    const unit = modelFrame.value.unit
    return { code: MODEL_MAP_CRS, unit, extent, key: `${MODEL_MAP_CRS}|${unit}|${extent.join(',')}` }
  })

  const view = computed(() => {
    if (mode.value === 'crs') return { mode: 'crs' }
    if (!modelFrame.value) return null
    const stale = new Set(PRODUCT_KINDS.filter((k) => productOf(k) && recon.productFrameStatus(productOf(k))?.stale))
    return { mode: 'model', frame: modelFrame.value.frame, stale }
  })

  const placements = computed(() => (view.value ? PRODUCT_KINDS.map((kind) => ({
    kind, placed: placeProductLayer(kind, productOf(kind), recon.productLayers[kind], view.value),
  })) : []))

  const productMapLayers = computed(() => placements.value.map((p) => p.placed?.layer).filter(Boolean))

  const mapLayers = computed(() => (mode.value === 'crs'
    ? [...external.mapRasters, ...productMapLayers.value]
    : productMapLayers.value))

  // One line per thing the user asked for that this frame cannot show, so an
  // "On Map" layer never silently fails to appear.
  const notes = computed(() => {
    const out = placements.value.filter((p) => p.placed?.reason)
      .map((p) => `${productLabel(p.kind, productOf(p.kind))} is not shown: ${p.placed.reason}.`)
    if (mode.value === 'model') {
      out.unshift(`Model frame (${modelFrame.value?.unit ?? 'model units'}, no CRS): GCPs, footprints, GPS positions `
        + 'and reference rasters are hidden.')
    }
    return out
  })

  // Geometry/value sources for the status-bar probe (it runs per mouse move), so
  // each is rebuilt only when its product changes.
  const sources = {
    dem: computed(() => (recon.dem ? createProductRasterSource('dem', recon.dem) : null)),
    ortho: computed(() => (recon.ortho ? createProductRasterSource('ortho', recon.ortho) : null)),
  }

  // A block-built DEM (SAT-3) answers the probe from its COG: the full-resolution cell
  // under the cursor, read as a one-cell window in the worker. The probe stays sync —
  // until the read lands it shows the overview's value, and `fullCell` (reactive) makes
  // the status bar re-probe when it does. One read in flight; the newest cell next.
  const fullCell = shallowRef(null) // { key, value }
  let cellBusy = false, cellWanted = null
  function fullResolutionProbe(hit, dem, x, y) {
    const col = Math.floor((x - dem.originX) / dem.fullGsd), row = Math.floor((dem.originY - y) / dem.fullGsd)
    const key = `${dem.createdAt}:${col}:${row}`
    if (fullCell.value?.key === key) return { ...hit, value: fullCell.value.value }
    cellWanted = { key, dem, x: dem.originX + (col + 0.5) * dem.fullGsd, y: dem.originY - (row + 0.5) * dem.fullGsd }
    if (!cellBusy) queueMicrotask(pumpCell)
    return { ...hit, pending: true }
  }
  async function pumpCell() {
    if (cellBusy) return
    cellBusy = true
    while (cellWanted) {
      const { key, dem, x, y } = cellWanted
      cellWanted = null
      let value = null
      try {
        const w = await readDemWindow({ dem: demRef(dem), rect: { minX: x, maxX: x, minY: y, maxY: y }, maxCells: 1 })
        value = w && Number.isFinite(w.data[0]) ? w.data[0] : null
      } catch { value = null }
      fullCell.value = { key, value }
    }
    cellBusy = false
  }

  // Sync probe for the map status bar at a point in the MAP's coordinates: the
  // topmost layer whose extent covers it — same contract as
  // useExternalStore.probeRasterAt, which it falls through to on the CRS map. A
  // computed product's planes are always in memory.
  function probeAt(x, y) {
    const layers = productMapLayers.value
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      let rx = x, ry = y
      if (layer.offset) {
        rx = x - layer.offset[0]; ry = y - layer.offset[1]
      } else if (layer.crs !== projects.currentCrs) {
        try { [rx, ry] = transform([x, y], projects.currentCrs, layer.crs) } catch { continue }
      }
      const src = sources[layer.kind].value
      const px = src?.worldToPixel(rx, ry)
      if (!px || px.col < 0 || px.row < 0 || px.col >= layer.width || px.row >= layer.height) continue
      const hit = { id: layer.id, name: layer.name, kind: layer.kind, loaded: true,
        value: layer.kind === 'dem' ? src.cellValueAt(rx, ry) : null }
      if (layer.kind === 'dem' && recon.dem?.cog) return fullResolutionProbe(hit, recon.dem, rx, ry)
      return hit
    }
    return mode.value === 'crs' ? external.probeRasterAt(x, y) : null
  }

  // ── Measuring on the map ─────────────────────────────────────────────
  // Targets are the map's raster layers. Automatic choice: the first DEM, since
  // only a DEM serves every tool (profile, volume) — else the top layer.
  const measureTargets = computed(() => mapLayers.value.map((l) => ({
    id: l.id, name: l.name, kind: l.kind === 'dem' ? 'dem' : 'ortho',
  })))
  const measureTargetId = computed(() => {
    const ts = measureTargets.value
    if (!ts.length) return null
    if (measureChoice.value && ts.some((t) => t.id === measureChoice.value)) return measureChoice.value
    return (ts.find((t) => t.kind === 'dem') ?? ts[ts.length - 1]).id
  })
  function setMeasureTarget(id) { measureChoice.value = id }
  // What RasterMeasurements needs for the target: the record it stamps and labels
  // measurements with, its RasterSource (computed or imported alike — an imported
  // one only once hydrated), and a computed product's frame status.
  const measureTarget = computed(() => {
    const layer = mapLayers.value.find((l) => l.id === measureTargetId.value)
    if (!layer) return null
    const kind = layer.kind === 'dem' ? 'dem' : 'ortho'
    if (layer.product) {
      const product = productOf(kind)
      return { layer, product, source: sources[kind].value, kind, frameStatus: recon.productFrameStatus(product) }
    }
    return { layer, product: layer, source: external.sources.get(layer.id) ?? null, kind, frameStatus: null }
  })

  // ── Markers on the model map ────────────────────────────────────────────────
  // Triangulated from their marks (the scale-bar endpoint path) and taken into
  // the map frame. Only computed while the model map is showing.
  const modelMarkers = shallowRef([])
  let markerToken = 0
  watch([() => mode.value, () => modelFrame.value, () => gcpsStore.gcps], async () => {
    const t = ++markerToken
    const f = modelFrame.value?.frame
    if (mode.value !== 'model' || !f) { modelMarkers.value = []; return }
    try {
      const list = await recon.markerPositions()
      if (t !== markerToken) return
      modelMarkers.value = list.map((m) => { const [x, y] = f.fromSfm(m.pos); return { id: m.id, name: m.name, x, y } })
    } catch {
      if (t === markerToken) modelMarkers.value = []
    }
  }, { deep: true, immediate: true })

  return {
    mapMode: mode, toggleModelFrame, mapFrame, modelCameras, modelMarkers, mapNotes: notes,
    productMapLayers, mapLayers, probeAt,
    measureTargets, measureTargetId, setMeasureTarget, measureTarget,
  }
}
