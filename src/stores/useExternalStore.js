import { ref, shallowRef, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection } from '../core/crs.js'
import { prepareRasterCog } from '../workers/computeClient.js'
import * as opfs from '../utils/opfs.js'
import { createDocumentSaver } from '../utils/documentSaver.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import { createRasterImport } from './external/rasterImport.js'
import { createRasterSampling } from './external/rasterSampling.js'
import { createRasterStyle } from './external/rasterStyle.js'

// Project-scoped store: **external reference rasters** — georeferenced DEMs and
// orthophotos the user imported rather than the app produced. Ground truth, used
// to give map-placed GCPs an elevation, as a map basemap, a GCP-picking surface,
// and a validation target for the reconstruction.
//
// Two invariants carry this store:
//
//  1. **Loading is lazy, and that is load-bearing.** `restore` reads only
//     `external/index.json` (metadata + a small preview PNG); the pixel plane is
//     hydrated by `ensureRasterLoaded(id)` on first sample/draw. A REMA tile is
//     hundreds of MB — eagerly loading it on project open would undo the whole
//     dense memory budget. Consequently, exactly as with depth maps, **any "do
//     we have a reference DEM" gate must read `rasters`/`hasReferenceDem`, never
//     the loaded-source map** (which is empty on a fresh reopen).
//
//  2. **The raster keeps its native CRS; the *query* is reprojected.** Warping a
//     whole raster into the project CRS at import resamples once and loses data,
//     costs minutes, and would have to redo itself on every CRS change. Instead
//     `sampleAt` reprojects the single query point into raster space — exact,
//     free, survives `handleSetCrs`, and it's the polar-correct choice.
//
// See docs/METHODS.md and plan-external-reference-data.md §A3/§A4/§A6.
export const useExternalStore = registerProjectStore(
  defineStore('external', () => {
    const { log } = useLog()
    const projects = useProjectsStore()
    const { currentCrs } = storeToRefs(projects)

    // RasterMeta[] — metadata only. Always populated after restore; the planes are not.
    //   { id, name, kind:'dem'|'ortho', width, height, bands, dtype,
    //     crs, geoTransform:{originX,originY,scaleX,scaleY},
    //     nodata, zMin, zMax, horizontalAccuracy, verticalDatum, verticalAccuracy, vOffset,
    //     previewDataUrl, importedAt, classification }
    const rasters = ref([])

    // Transient imports shown in the sidebar immediately, while the worker reads
    // and classifies a potentially large GeoTIFF. Kept separate from `rasters` so
    // incomplete records never participate in DEM gates, map layers, or project
    // persistence.
    const pendingRasters = ref([])

    // id → RasterSource. shallowRef: the planes are large typed arrays and Vue
    // reactivity over them is pure waste (and a Proxy can't be postMessage'd).
    const sources = shallowRef(new Map())

    // In-flight hydrations, so two concurrent samplers don't both read the sidecar.
    const loading = new Map()
    const activeImports = new Set()
    const pendingWorkCount = ref(0)

    // id → the ORIGINAL imported File, held in memory for this session.
    //
    // `external/{id}.src` is only written when the project is persisting, so in a
    // non-persisting project OPFS has no copy and every re-decode path — kind flip,
    // restyle, and above all "import as a source image instead" — used to fail with
    // "re-add the file" on a raster imported seconds earlier. `convertImageToRaster`
    // already handles the mirror case by reaching for the in-memory `img.file`;
    // rasters had no equivalent, which made the misroute escape hatch one-way.
    //
    // Cheap: a dropped/picked File is a disk-backed handle, not the bytes.
    // Deliberately NOT on the record — the record is serialised to index.json.
    const originals = new Map()
    const styleRequests = new Map(),
      displayFiles = new Map(),
      displayLoading = new Map()
    let conversionQueue = Promise.resolve()
    async function displayFile(id) {
      if (displayFiles.has(id)) return displayFiles.get(id)
      if (displayLoading.has(id)) return displayLoading.get(id)
      const projectId = projects.currentProjectId,
        meta = rasterById(id)
      if (!meta) return null
      const task = (async () => {
        let file = isPersisting() ? await opfs.loadExternalCog(projectId, id) : null
        if (!file) {
          const original = await originalFile(id)
          if (!original) return null
          const run = conversionQueue
            .catch(() => {})
            .then(async () => {
              if (projectId !== projects.currentProjectId || rasterById(id) !== meta) return null
              try {
                const result = await prepareRasterCog(original, JSON.parse(JSON.stringify(meta)))
                if (
                  !result.reused &&
                  isPersisting() &&
                  projects.currentProjectId === projectId &&
                  rasterById(id) === meta
                )
                  await opfs.saveExternalCog(projectId, id, result.file)
                log(
                  `Raster ${meta.name}: tiled display ${result.reused ? 'reused' : 'prepared'} in ${result.ms.toFixed(0)} ms`,
                  'info',
                  'Import',
                )
                return result.file
              } catch (err) {
                log(`Raster ${meta.name}: ${err.message}; displaying the original GeoTIFF`, 'info', 'Import')
                return original
              }
            })
          conversionQueue = run
          file = await run
        }
        if (file && projects.currentProjectId === projectId && rasterById(id) === meta) {
          displayFiles.set(id, file)
          return file
        }
        return null
      })()
      displayLoading.set(id, task)
      try {
        return await task
      } finally {
        if (displayLoading.get(id) === task) displayLoading.delete(id)
      }
    }

    // The original file, wherever it lives: memory first, then OPFS. Null when the
    // project was reopened and never persisted the source.
    async function originalFile(id) {
      const held = originals.get(id)
      if (held) return held
      const projectId = projects.currentProjectId
      const file = await opfs.loadExternalSource(projectId, id)
      if (projectId !== projects.currentProjectId) return null
      if (file) originals.set(id, file)
      return file
    }

    const isPersisting = () => projects.isPersisting

    // ── getters ────────────────────────────────────────────────────────────────
    // Gate on the INDEX, never on `sources` — see invariant 1.
    const demRasters = computed(() => rasters.value.filter((r) => r.kind === 'dem'))
    const orthoRasters = computed(() => rasters.value.filter((r) => r.kind === 'ortho'))
    const hasReferenceDem = computed(() => demRasters.value.length > 0)
    const rasterById = (id) => rasters.value.find((r) => r.id === id) ?? null

    // The DEM a "fill Z" action should use when the user didn't pick one: the only
    // one, or null if ambiguous — silently picking among several reference DEMs
    // with different vertical datums is exactly the unbounded error §A6 warns about.
    const defaultDem = computed(() => (demRasters.value.length === 1 ? demRasters.value[0] : null))

    // True when two loaded DEMs declare different vertical datums. Mixing those
    // without saying so is unbounded; a constant offset is merely wrong-but-bounded.
    const mixedVerticalDatums = computed(() => {
      const set = new Set(demRasters.value.map((r) => r.verticalDatum || 'unknown'))
      return set.size > 1
    })

    const makeId = () => `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    // Runtime capability state, not raster metadata. Projection definitions can
    // become available later, so retry and clear the flag on success.
    async function resolveRasterCrs(meta) {
      if (!meta?.crs) {
        if (meta) delete meta.crsUnresolved
        return true
      }
      try {
        await ensureProjection(meta.crs)
        delete meta.crsUnresolved
        return true
      } catch {
        meta.crsUnresolved = true
        return false
      }
    }

    // ── map display (A-4) ──────────────────────────────────────────────────────
    // `visible` + `opacity` are **view state**, persisted in the index so a project
    // reopens looking the way you left it. Deliberately a toggle rather than a
    // one-shot "show on map" action: which reference layers are up is something you
    // adjust while working, and a one-shot has no way back.
    //
    // Drawing does NOT hydrate the plane — the map layer renders `previewDataUrl`
    // (the ≤1024 px PNG already in the index) over the raster's bounds. A REMA tile
    // on screen at basemap zoom is a handful of screen pixels wide; decoding
    // hundreds of MB for that would undo invariant 1 for a purely cosmetic gain.
    const mapRasters = computed(() => rasters.value.filter((r) => r.visible && r.previewDataUrl && !r.crsUnresolved))

    async function setRasterVisible(id, on) {
      const meta = rasterById(id)
      if (!meta) return false
      if (on && meta.crs && !(await resolveRasterCrs(meta))) {
        log(
          `Reference raster "${meta.name}": CRS ${meta.crs} is unresolved, so it cannot ` +
            'be placed safely on the map.',
          'warn',
          'Import',
        )
        return false
      }
      meta.visible = !!on
      if (meta.opacity == null) meta.opacity = 1
      log(`Reference raster "${meta.name}": ${meta.visible ? 'shown on' : 'hidden from'} map`, 'info', 'Import')
      await save()
      return true
    }

    async function setRasterOpacity(id, opacity) {
      const meta = rasterById(id)
      if (!meta) return false
      meta.opacity = Math.max(0, Math.min(1, Number(opacity) || 0))
      await save()
      return true
    }

    async function renameRaster(id, name) {
      const meta = rasterById(id)
      if (!meta || !name) return false
      meta.name = name
      await save()
      return true
    }

    async function removeRaster(id) {
      const i = rasters.value.findIndex((r) => r.id === id)
      if (i < 0) return false
      const [meta] = rasters.value.splice(i, 1)
      const next = new Map(sources.value)
      next.delete(id)
      sources.value = next
      originals.delete(id)
      displayFiles.delete(id)
      displayLoading.delete(id)
      if (isPersisting()) {
        await opfs.deleteExternalPlane(projects.currentProjectId, id).catch(() => {})
        await save()
      }
      log(`Reference raster: removed "${meta.name}"`, 'info', 'Import')
      return true
    }

    // ── persistence ────────────────────────────────────────────────────────────
    // Only the index — the planes are written once at import and pruned on remove.
    const save = createDocumentSaver({
      label: 'external',
      currentProjectId: () => projects.currentProjectId,
      isPersisting,
      build: () => ({
        version: 1,
        rasters: rasters.value.map((r) => {
          const persisted = { ...r }
          delete persisted.crsUnresolved
          return persisted
        }),
      }),
      write: opfs.saveExternalIndex,
      onError: (err) => log(`Reference raster index save failed — ${err?.message ?? err}`, 'error', 'Import'),
    })

    // Only { purge: true } deletes persisted data; a plain clear (project
    // switch/close) leaves OPFS intact so restore can read it back.
    function clear({ purge = false } = {}) {
      rasters.value = []
      pendingRasters.value = []
      sources.value = new Map()
      loading.clear()
      originals.clear()
      styleRequests.clear()
      displayFiles.clear()
      displayLoading.clear()
      if (purge && isPersisting()) opfs.deleteExternalAll(projects.currentProjectId).catch(() => {})
    }

    // Reads the INDEX ONLY. The planes stay on disk until something samples or
    // draws them (see invariant 1) — this is the single most important line in
    // the store.
    async function restore({ projectId }) {
      rasters.value = []
      pendingRasters.value = []
      sources.value = new Map()
      originals.clear()
      styleRequests.clear()
      displayFiles.clear()
      displayLoading.clear()
      const data = await opfs.loadExternalIndex(projectId)
      if (!data || !Array.isArray(data.rasters) || !data.rasters.length) return

      // `visible`/`opacity` are absent on rasters imported before A-4 — default to
      // hidden at full opacity rather than healing the file (nothing is lost, and a
      // project that never used the map layer shouldn't gain rewritten records).
      rasters.value = data.rasters.map((r) => ({
        ...r,
        gpuReady: false,
        visible: !!r.visible,
        opacity: r.opacity ?? 1,
      }))
      // Re-resolve each raster's CRS so the first sample doesn't have to await a
      // projection fetch mid-interaction.
      await Promise.all(rasters.value.map((r) => (r.crs ? resolveRasterCrs(r) : null)))
      // Drop sidecars belonging to rasters no longer in the index.
      // Stale-cache cleanup is maintenance, not state required to use the project.
      // Keep it off the blocking open path.
      opfs.pruneExternalPlanes(projectId, new Set(rasters.value.map((r) => r.id))).catch(() => {})

      log(
        `Reference rasters restored: ${rasters.value.length} ` +
          `(${demRasters.value.length} DEM, ${orthoRasters.value.length} ortho) — pixel data loads on demand`,
        'success',
        'Import',
      )
      if (mixedVerticalDatums.value) {
        log(
          'Reference DEMs declare different vertical datums — elevations from them are ' + 'not directly comparable.',
          'warn',
          'Import',
        )
      }
    }

    // Import and hydration, sampling, style edits (stores/external/): after `save`,
    // which they take.
    const { buildSource, ensureRasterLoaded, flushPendingWork, importRaster, readRasterWindow, setSource } =
      createRasterImport({
        activeImports,
        currentCrs,
        displayFile,
        isPersisting,
        loading,
        log,
        makeId,
        mixedVerticalDatums,
        originalFile,
        originals,
        pendingRasters,
        pendingWorkCount,
        projects,
        rasterById,
        rasters,
        resolveRasterCrs,
        save,
        sources,
      })
    const {
      pickGroundControl,
      probeRasterAt,
      referenceDemSampler,
      sampleReferenceDem,
      toProjectCoords,
      toRasterCoords,
    } = createRasterSampling({
      currentCrs,
      defaultDem,
      ensureRasterLoaded,
      mapRasters,
      rasterById,
      resolveRasterCrs,
      sources,
    })
    const { setRasterAccuracy, setRasterKind, setRasterStyle } = createRasterStyle({
      buildSource,
      isPersisting,
      log,
      originalFile,
      projects,
      rasterById,
      save,
      setSource,
      sources,
      styleRequests,
    })

    return {
      rasters,
      pendingRasters,
      pendingWorkCount,
      sources,
      demRasters,
      orthoRasters,
      hasReferenceDem,
      defaultDem,
      mixedVerticalDatums,
      mapRasters,
      rasterById,
      importRaster,
      originalFile,
      displayFile,
      ensureRasterLoaded,
      sampleReferenceDem,
      referenceDemSampler,
      probeRasterAt,
      toRasterCoords,
      toProjectCoords,
      pickGroundControl,
      setRasterKind,
      setRasterStyle,
      setRasterAccuracy,
      setRasterVisible,
      setRasterOpacity,
      readRasterWindow,
      renameRaster,
      removeRaster,
      save,
      restore,
      clear,
      flushPendingWork,
    }
  }),
)
