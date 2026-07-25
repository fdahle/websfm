import { ref, shallowRef, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, transform } from '../core/crs.js'
import { createFlatRasterSource } from '../core/io/rasterSource.js'
import { rasterBounds } from '../core/io/rasterSample.js'
import { describeStyle, styleStamp } from '../core/io/rasterStyle.js'
import { parseRasterFile, restyleRasterPreview } from '../workers/computeClient.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'

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
// See METHODS.md §? and plan-external-reference-data.md §A3/§A4/§A6.
export const useExternalStore = registerProjectStore(defineStore('external', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const { currentCrs } = storeToRefs(projects)

  // RasterMeta[] — metadata only. Always populated after restore; the planes are not.
  //   { id, name, kind:'dem'|'ortho', width, height, bands, dtype,
  //     crs, geoTransform:{originX,originY,scaleX,scaleY},
  //     nodata, zMin, zMax, verticalDatum, verticalAccuracy, vOffset,
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

  // The original file, wherever it lives: memory first, then OPFS. Null when the
  // project was reopened and never persisted the source.
  async function originalFile(id) {
    const held = originals.get(id)
    if (held) return held
    const file = await opfs.loadExternalSource(projects.currentProjectId, id)
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

  // ── import ─────────────────────────────────────────────────────────────────
  // Decode + classify off-thread, then commit. `forceKind` comes from the import
  // modal when the sniff was low-confidence. Returns the new RasterMeta, or null.
  async function importRaster(file, { forceKind = null } = {}) {
    const task = importRasterNow(file, { forceKind })
    activeImports.add(task)
    pendingWorkCount.value++
    try { return await task } finally {
      activeImports.delete(task)
      pendingWorkCount.value--
    }
  }

  async function importRasterNow(file, { forceKind = null } = {}) {
    if (!file) return null
    const projectId = projects.currentProjectId
    const id = makeId()
    pendingRasters.value.push({ id, name: file.name })
    const removePending = () => {
      const i = pendingRasters.value.findIndex((r) => r.id === id)
      if (i >= 0) pendingRasters.value.splice(i, 1)
    }

    let meta, plane
    try {
      const buffer = await file.arrayBuffer()
      ;({ meta, plane } = await parseRasterFile(buffer, file.name, {
        forceKind,
        onLog: (m, l, c) => log(m, l, c),
      }))
    } catch (err) {
      removePending()
      log(`Reference raster: could not read ${file.name} — ${err?.message ?? err}`, 'error', 'Import')
      return null
    }

    const record = {
      ...meta,
      id,
      importedAt: Date.now(),
      // Which style the persisted full-res plane was composed with. A restyle
      // updates `style` but not this, marking the plane stale so it re-decodes
      // lazily — see setRasterStyle / ensureRasterLoaded.
      planeStyleStamp: styleStamp(meta.style),
      // Declared vertical accuracy (σ, in the raster's vertical unit). Null until
      // the user sets it — and a GCP Z filled from a raster with no declared
      // accuracy must NOT claim survey-grade σ, so the fill action refuses.
      verticalAccuracy: null,
      vOffset: 0,
      // Map display (A-4). Off by default: importing a reference dataset is not the
      // same as wanting it drawn over the project, and a large ortho appearing
      // unbidden under the tie-points is a surprise, not a feature.
      onMap: false,
      opacity: 1,
    }
    delete record.plane

    // Resolve the raster's own CRS so `sampleAt` can reproject the query into it
    // later. Done once here, at import, rather than on every sample.
    if (record.crs) {
      if (!(await resolveRasterCrs(record))) {
        log(`Reference raster: CRS ${record.crs} could not be resolved — sampling and map `
          + 'display are disabled until its projection definition becomes available.', 'warn', 'Import')
      }
    } else {
      log(`Reference raster ${record.name}: no CRS in the GeoTIFF — assuming the project CRS`, 'warn', 'Import')
    }

    // Parsing and CRS resolution may take seconds. A lifecycle change clears
    // this store; never let the old operation repopulate or persist into the
    // newly active project.
    if (projects.currentProjectId !== projectId) {
      removePending()
      log(`Reference raster: ${file.name} finished after the project changed — import discarded`,
        'warn', 'Import')
      return null
    }

    // Replace the disabled loading row with the complete record. Both carry the
    // same id, so the transition is stable from the user's perspective.
    removePending()
    rasters.value.push(record)
    setSource(record.id, buildSource(record, plane))
    // Before the persistence check, not inside it: a non-persisting project needs
    // this to be the retained copy, and that is exactly when nothing else has one.
    originals.set(record.id, file)

    if (isPersisting()) {
      await opfs.saveExternalPlane(projectId, record.id, plane.buffer)
        .catch((err) => log(`Reference raster save failed — ${err?.message ?? err}`, 'error', 'Import'))
      // Keep the original file: it's the source of truth a kind flip re-decodes
      // from, and (A-7) what "cache locally" would materialise.
      await opfs.saveExternalSource(projectId, record.id, file)
        .catch((err) => log(`Reference raster source save failed — ${err?.message ?? err}`, 'warn', 'Import'))
      await save()
    }

    log(`Reference raster: added "${record.name}" (${record.kind.toUpperCase()}, `
      + `${record.width}×${record.height}, ${record.crs || 'no CRS'})`, 'success', 'Import')
    if (mixedVerticalDatums.value) {
      log('Reference rasters declare different vertical datums — elevations from them '
        + 'are not directly comparable. Check each dataset\'s vertical datum.', 'warn', 'Import')
    }
    return record
  }

  async function flushPendingWork() {
    while (activeImports.size) await Promise.allSettled([...activeImports])
  }

  // Rebuild a RasterSource from a meta + its plane. DEM planes are Float32 with
  // nodata already folded to NaN (workers/ops/io.js); ortho planes are RGBA.
  function buildSource(meta, plane) {
    if (meta.kind === 'dem') {
      const data = plane instanceof Float32Array ? plane : new Float32Array(plane)
      return createFlatRasterSource(meta, data, { previewDataUrl: meta.previewDataUrl })
    }
    const rgba = plane instanceof Uint8Array ? plane : new Uint8Array(plane)
    // An ortho has no scalar value plane — sampleAt returns null and callers use
    // the geometry helpers (worldToPixel) plus `rgba()` for colour.
    return createFlatRasterSource(meta, null, { rgba, previewDataUrl: meta.previewDataUrl })
  }

  function setSource(id, source) {
    const next = new Map(sources.value)
    next.set(id, source)
    sources.value = next
  }

  // ── lazy hydration ─────────────────────────────────────────────────────────
  // Hydrate one raster's plane from its OPFS sidecar. Idempotent + concurrency
  // safe. Returns the RasterSource, or null when the sidecar is gone.
  //
  // A plane whose stamp no longer matches the raster's style is **stale**, not
  // corrupt: `setRasterStyle` repaints the preview immediately and defers the
  // expensive full-res compose to here. In that case the sidecar is bypassed and
  // the original file re-decoded — the one place the seconds get spent, paid by
  // the sampler that actually needs exact pixels. A raster with no recorded stamp
  // (imported before this existed) is treated as current; nothing re-decodes on
  // upgrade.
  async function ensureRasterLoaded(id) {
    const existing = sources.value.get(id)
    if (existing) return existing
    if (loading.has(id)) return loading.get(id)

    const meta = rasterById(id)
    if (!meta) return null

    const wanted = styleStamp(meta.style)
    if ((meta.planeStyleStamp ?? wanted) !== wanted) {
      const p = redecodePlane(meta).finally(() => loading.delete(id))
      loading.set(id, p)
      return p
    }

    const p = (async () => {
      const buf = await opfs.loadExternalPlane(projects.currentProjectId, id)
      if (!buf) {
        log(`Reference raster "${meta.name}": pixel data is missing — re-import the file.`, 'warn', 'Import')
        return null
      }
      // Float32 elevations and RGBA pixels are both 4 bytes per pixel.
      const expected = meta.width * meta.height * 4
      if (buf.byteLength !== expected) {
        // A truncated plane would sample as silently wrong elevations, so refuse
        // it outright rather than serving partial data (cf. the depth-map codec).
        log(`Reference raster "${meta.name}": pixel data is ${buf.byteLength} bytes, `
          + `expected ${expected} — discarding as corrupt.`, 'error', 'Import')
        return null
      }
      const plane = meta.kind === 'dem' ? new Float32Array(buf) : new Uint8Array(buf)
      const source = buildSource(meta, plane)
      setSource(id, source)
      log(`Reference raster "${meta.name}": loaded ${(buf.byteLength / 1e6).toFixed(1)} MB`, 'info', 'Import')
      return source
    })().finally(() => loading.delete(id))

    loading.set(id, p)
    return p
  }

  // Rebuild a raster's full-resolution plane from the retained original, under
  // its CURRENT style, and re-persist it. Only reached when the cached plane is
  // stale (a restyle deferred the compose) — never on a normal open.
  //
  // Returns null rather than throwing: a missing original means the raster can
  // still be *drawn* (the preview lives in the index), just not sampled, and
  // every caller here already treats null as "no data at this point".
  async function redecodePlane(meta) {
    const file = await originalFile(meta.id)
    if (!file) {
      log(`Reference raster "${meta.name}": restyled, but the original file is no longer `
        + 'stored, so full-resolution pixels cannot be rebuilt. Re-import it to sample it.',
      'warn', 'Import')
      return null
    }
    try {
      const buffer = await file.arrayBuffer()
      const { plane } = await parseRasterFile(buffer, meta.name, {
        forceKind: meta.kind,
        style: meta.style,
        onLog: (m, l, c) => log(m, l, c),
      })
      const source = buildSource(meta, plane)
      setSource(meta.id, source)
      meta.planeStyleStamp = styleStamp(meta.style)
      if (isPersisting()) {
        await opfs.saveExternalPlane(projects.currentProjectId, meta.id, plane.buffer).catch(() => {})
        await save()
      }
      return source
    } catch (err) {
      log(`Reference raster "${meta.name}": rebuilding full-resolution pixels failed — `
        + `${err?.message ?? err}`, 'error', 'Import')
      return null
    }
  }

  // ── sampling ───────────────────────────────────────────────────────────────
  // Sample a reference DEM at a point given in the **project** CRS. Reprojects
  // the query into the raster's native CRS (invariant 2) and returns the value,
  // plus the declared vertical accuracy so callers never have to invent a σ.
  // → { z, accuracy, datum, rasterId, rasterName } | null
  async function sampleReferenceDem(x, y, { rasterId = null } = {}) {
    const meta = rasterId ? rasterById(rasterId) : defaultDem.value
    if (!meta || meta.kind !== 'dem') return null
    if (meta.crsUnresolved && !(await resolveRasterCrs(meta))) return null
    const source = await ensureRasterLoaded(meta.id)
    if (!source) return null

    const coords = toRasterCoords(meta, x, y)
    if (!coords) return null
    const [rx, ry] = coords
    const raw = source.sampleAt(rx, ry)
    if (raw == null) return null
    return {
      z: raw + (meta.vOffset || 0),
      accuracy: meta.verticalAccuracy ?? null,
      datum: meta.verticalDatum || 'unknown',
      rasterId: meta.id,
      rasterName: meta.name,
    }
  }

  // Synchronous point probe for the map status bar: the topmost on-map raster
  // whose extent covers this **project-CRS** point. Deliberately reads only
  // already-hydrated planes (invariant 1) — a cursor move must never kick off the
  // lazy load of a hundreds-of-MB tile, so an un-hydrated hit reports
  // `loaded:false` and the caller offers to load it.
  // → { id, name, kind, loaded, value } | null
  function probeRasterAt(x, y) {
    const list = mapRasters.value
    for (let i = list.length - 1; i >= 0; i--) {
      const meta = list[i]
      const coords = toRasterCoords(meta, x, y)
      if (!coords) continue
      const [rx, ry] = coords
      const b = rasterBounds({ width: meta.width, height: meta.height, geoTransform: meta.geoTransform })
      if (!b) continue
      const [minX, minY, maxX, maxY] = b
      if (rx < minX || rx > maxX || ry < minY || ry > maxY) continue
      const source = sources.value.get(meta.id)
      if (!source) return { id: meta.id, name: meta.name, kind: meta.kind, loaded: false, value: null }
      const raw = meta.kind === 'dem' ? source.sampleAt(rx, ry) : null
      return {
        id: meta.id,
        name: meta.name,
        kind: meta.kind,
        loaded: true,
        value: raw == null ? null : raw + (meta.vOffset || 0),
      }
    }
    return null
  }

  // Project CRS → the raster's native CRS. A raster with no declared CRS is
  // assumed to use the project CRS (warned at import). A declared but unresolved
  // CRS is unsafe to guess, so callers receive null until resolution succeeds.
  function toRasterCoords(meta, x, y) {
    if (meta.crsUnresolved) return null
    if (!meta.crs || !currentCrs.value || meta.crs === currentCrs.value) {
      return [x, y]
    }
    try {
      return transform([x, y], currentCrs.value, meta.crs)
    } catch {
      return null
    }
  }

  // The raster's native CRS → project CRS. The inverse of the above, for GCP
  // picking (A-5), where the click is in raster space and the GCP is not.
  function toProjectCoords(meta, x, y) {
    if (meta.crsUnresolved) return null
    if (!meta.crs || !currentCrs.value || meta.crs === currentCrs.value) {
      return [x, y]
    }
    try {
      return transform([x, y], meta.crs, currentCrs.value)
    } catch {
      return null
    }
  }

  // ── mutation ───────────────────────────────────────────────────────────────
  // Flip a raster's kind after import ("Treat as DEM / orthophoto").
  //
  // This action is what makes skipping the import modal on a high-confidence
  // sniff defensible — without it a silent misclassification is a
  // delete-and-reimport. It also covers the genuinely undecidable case: an 8-bit
  // hillshade is a DEM by intent and imagery by content, and only the user knows
  // which they want.
  //
  // The geotransform is identical either way, but the *plane* is not (Float32
  // elevations vs RGBA pixels), so this re-decodes from the retained original
  // rather than relabelling bytes that would then be read as the wrong type.
  async function setRasterKind(id, kind) {
    const meta = rasterById(id)
    if (!meta || meta.kind === kind) return false

    const file = await originalFile(id)
    if (!file) {
      log(`Reference raster "${meta.name}": the original file is no longer stored, so it `
        + `cannot be re-read as a ${kind.toUpperCase()}. Re-import it and pick the kind in `
        + 'the import dialog.', 'warn', 'Import')
      return false
    }

    let next, plane
    try {
      const buffer = await file.arrayBuffer()
      ;({ meta: next, plane } = await parseRasterFile(buffer, meta.name, {
        forceKind: kind,
        onLog: (m, l, c) => log(m, l, c),
      }))
    } catch (err) {
      log(`Reference raster "${meta.name}": re-decode as ${kind.toUpperCase()} failed — `
        + `${err?.message ?? err}`, 'error', 'Import')
      return false
    }

    // Keep the user's own fields (name, vertical declarations); replace only what
    // the decode determines.
    Object.assign(meta, next, {
      id: meta.id,
      name: meta.name,
      importedAt: meta.importedAt,
      verticalAccuracy: meta.verticalAccuracy,
      vOffset: meta.vOffset,
      // A vertical datum the *user* set survives; one merely defaulted from the
      // geokeys is re-derived.
      verticalDatum: meta.verticalDatumUserSet ? meta.verticalDatum : next.verticalDatum,
    })
    // This DID compose the plane, so the cached pixels are current by definition.
    meta.planeStyleStamp = styleStamp(meta.style)

    setSource(id, buildSource(meta, plane))
    if (isPersisting()) {
      await opfs.saveExternalPlane(projects.currentProjectId, id, plane.buffer).catch(() => {})
      await save()
    }
    log(`Reference raster "${meta.name}": now treated as ${kind.toUpperCase()}`, 'success', 'Import')
    return true
  }

  // Band math / contrast stretch for a multi-band or high-bit-depth raster.
  //
  // Same shape as setRasterKind, and for the same reason: the plane stored here
  // is baked 8-bit RGBA, so a restyle is a RE-DECODE from the retained original,
  // not a recolour of bytes we still have. Keeping the raw uint16 bands around
  // to avoid that would cost 300 MB for one Sentinel-2 scene — exactly the
  // memory the lazy-loading design exists to avoid.
  // Band math / contrast stretch for a multi-band or high-bit-depth raster.
  //
  // Deliberately does NOT rebuild the full-resolution plane. Everything the user
  // can see — the map layer, the raster tab — draws `previewDataUrl`, so the
  // restyle recomputes only that (≤1024 px, read straight out of geotiff at
  // preview size: tens of milliseconds). Re-decoding every band at full res and
  // writing hundreds of MB back to OPFS, which is what this used to do before the
  // preview repainted, made a dropdown change take seconds for no visible gain.
  //
  // The plane is instead **invalidated**: the loaded source is dropped and the
  // stamp on the persisted sidecar now disagrees with the style, so
  // `ensureRasterLoaded` re-decodes it at full res the next time something
  // actually samples pixels. That is the same lazy-hydration bargain the store is
  // built on (invariant 1) — the cost lands on the consumer that needs the
  // precision, not on the user nudging a gamma slider.
  async function setRasterStyle(id, style) {
    const meta = rasterById(id)
    if (!meta) return false

    const file = await originalFile(id)
    if (!file) {
      log(`Reference raster "${meta.name}": the original file is no longer stored, so it `
        + 'cannot be re-styled. Re-import it to change the band mapping.', 'warn', 'Import')
      return false
    }

    let resolved, previewDataUrl
    try {
      const buffer = await file.arrayBuffer()
      ;({ style: resolved, previewDataUrl } = await restyleRasterPreview(buffer, meta.name, style, {
        onLog: (m, l, c) => log(m, l, c),
      }))
    } catch (err) {
      log(`Reference raster "${meta.name}": re-style failed — ${err?.message ?? err}`, 'error', 'Import')
      return false
    }

    meta.style = resolved
    meta.previewDataUrl = previewDataUrl

    // Drop the hydrated plane: it was composed with the old style, and serving it
    // to a sampler now would return colours that no longer match what is drawn.
    if (sources.value.has(id)) {
      const next = new Map(sources.value)
      next.delete(id)
      sources.value = next
    }

    if (isPersisting()) await save()
    log(`Reference raster "${meta.name}": restyled — ${describeStyle(meta.style)}`
      + ' (full-resolution pixels re-decode on next use)', 'success', 'Import')
    return true
  }

  // Declared vertical datum + accuracy (§A6). Both are user-supplied because
  // neither is reliably in the file, and both matter: the datum bounds a
  // systematic error, the accuracy is what a filled GCP Z claims as its σ.
  async function setVerticalInfo(id, { verticalDatum, verticalAccuracy, vOffset } = {}) {
    const meta = rasterById(id)
    if (!meta) return false
    if (verticalDatum !== undefined) { meta.verticalDatum = verticalDatum; meta.verticalDatumUserSet = true }
    if (verticalAccuracy !== undefined) meta.verticalAccuracy = verticalAccuracy
    if (vOffset !== undefined) meta.vOffset = vOffset
    log(`Reference raster "${meta.name}": vertical datum ${meta.verticalDatum}`
      + `${meta.verticalAccuracy != null ? `, σ ${meta.verticalAccuracy}` : ''}`
      + `${meta.vOffset ? `, offset ${meta.vOffset}` : ''}`, 'info', 'Import')
    await save()
    return true
  }

  // ── map display (A-4) ──────────────────────────────────────────────────────
  // `onMap` + `opacity` are **view state**, persisted in the index so a project
  // reopens looking the way you left it. Deliberately a toggle rather than a
  // one-shot "show on map" action: which reference layers are up is something you
  // adjust while working, and a one-shot has no way back.
  //
  // Drawing does NOT hydrate the plane — the map layer renders `previewDataUrl`
  // (the ≤1024 px PNG already in the index) over the raster's bounds. A REMA tile
  // on screen at basemap zoom is a handful of screen pixels wide; decoding
  // hundreds of MB for that would undo invariant 1 for a purely cosmetic gain.
  const mapRasters = computed(() =>
    rasters.value.filter((r) => r.onMap && r.previewDataUrl && !r.crsUnresolved))

  async function setRasterOnMap(id, on) {
    const meta = rasterById(id)
    if (!meta) return false
    if (on && meta.crs && !(await resolveRasterCrs(meta))) {
      log(`Reference raster "${meta.name}": CRS ${meta.crs} is unresolved, so it cannot `
        + 'be placed safely on the map.', 'warn', 'Import')
      return false
    }
    meta.onMap = !!on
    if (meta.opacity == null) meta.opacity = 1
    log(`Reference raster "${meta.name}": ${meta.onMap ? 'shown on' : 'hidden from'} map`, 'info', 'Import')
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
    if (isPersisting()) {
      await opfs.deleteExternalPlane(projects.currentProjectId, id).catch(() => {})
      await save()
    }
    log(`Reference raster: removed "${meta.name}"`, 'info', 'Import')
    return true
  }

  // ── persistence ────────────────────────────────────────────────────────────
  // Only the index — the planes are written once at import and pruned on remove.
  async function save() {
    if (!isPersisting()) return
    await opfs.saveExternalIndex(projects.currentProjectId, {
      version: 1,
      rasters: rasters.value.map((r) => {
        const persisted = { ...r }
        delete persisted.crsUnresolved
        return persisted
      }),
    }).catch((err) => log(`Reference raster index save failed — ${err?.message ?? err}`, 'error', 'Import'))
  }

  // Only { purge: true } deletes persisted data; a plain clear (project
  // switch/close) leaves OPFS intact so restore can read it back.
  function clear({ purge = false } = {}) {
    rasters.value = []
    pendingRasters.value = []
    sources.value = new Map()
    loading.clear()
    originals.clear()
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
    const data = await opfs.loadExternalIndex(projectId)
    if (!data || !Array.isArray(data.rasters) || !data.rasters.length) return

    // `onMap`/`opacity` are absent on rasters imported before A-4 — default to
    // hidden at full opacity rather than healing the file (nothing is lost, and a
    // project that never used the map layer shouldn't gain rewritten records).
    rasters.value = data.rasters.map((r) => ({ ...r, onMap: !!r.onMap, opacity: r.opacity ?? 1 }))
    // Re-resolve each raster's CRS so the first sample doesn't have to await a
    // projection fetch mid-interaction.
    for (const r of rasters.value) {
      if (!r.crs) continue
      await resolveRasterCrs(r)
    }
    // Drop sidecars belonging to rasters no longer in the index.
    await opfs.pruneExternalPlanes(projectId, new Set(rasters.value.map((r) => r.id))).catch(() => {})

    log(`Reference rasters restored: ${rasters.value.length} `
      + `(${demRasters.value.length} DEM, ${orthoRasters.value.length} ortho) — pixel data loads on demand`,
    'success', 'Import')
    if (mixedVerticalDatums.value) {
      log('Reference DEMs declare different vertical datums — elevations from them are '
        + 'not directly comparable.', 'warn', 'Import')
    }
  }

  return {
    rasters, pendingRasters, pendingWorkCount, sources,
    demRasters, orthoRasters, hasReferenceDem, defaultDem, mixedVerticalDatums,
    mapRasters,
    rasterById,
    importRaster, originalFile, ensureRasterLoaded, sampleReferenceDem, probeRasterAt,
    toRasterCoords, toProjectCoords,
    setRasterKind, setRasterStyle, setVerticalInfo, setRasterOnMap, setRasterOpacity,
    renameRaster, removeRaster,
    save, restore, clear, flushPendingWork,
  }
}))
