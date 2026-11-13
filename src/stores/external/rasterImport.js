// The external store's import and lazy hydration: decode and classify a GeoTIFF off
// the main thread, commit it, and load its pixel plane on first use (useExternalStore.js
// ▸ invariant 1: loading is lazy).
//
// Moved verbatim from the store: everything it shares comes in by name.

import { ensureProjection, transform } from '../../core/crs.js'
import { createFlatRasterSource } from '../../core/io/rasterSource.js'
import { projectRasterWindow } from '../../core/io/projectRasterWindow.js'
import { usePosesStore } from '../usePosesStore.js'
import { useGcpsStore } from '../useGcpsStore.js'
import { styleStamp } from '../../core/io/rasterStyle.js'
import { parseRasterFile, readRasterWindow as workerReadRasterWindow } from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'

export function createRasterImport({
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
}) {
  // ── import ─────────────────────────────────────────────────────────────────
  // Decode + classify off-thread, then commit. `forceKind` comes from the import
  // modal when the sniff was low-confidence. `origin` names where a raster the app
  // fetched itself came from ('sentinel2'); a file the user brought has none.
  // Returns the new RasterMeta, or null.
  async function importRaster(file, { forceKind = null, origin = null } = {}) {
    const task = importRasterNow(file, { forceKind, origin })
    activeImports.add(task)
    pendingWorkCount.value++
    try {
      return await task
    } finally {
      activeImports.delete(task)
      pendingWorkCount.value--
    }
  }

  // The window of a raster too large for one plane (meta.tooLarge, workers/ops/io.js)
  // over the project: its images' positions and surveyed GCPs with a margin
  // (core/io/projectRasterWindow.js), in pixels of the raster. Null when neither is there
  // or the CRS cannot be resolved.
  async function rasterWindowFor(meta) {
    const crs = meta.crs ?? currentCrs.value
    const projCrs = currentCrs.value
    try {
      if (crs) await ensureProjection(crs)
      if (projCrs) await ensureProjection(projCrs)
    } catch {
      return null
    }
    const points = []
    // Image positions, and surveyed GCPs (a film block has GCPs and no GPS): the area
    // the project covers.
    const surveyed = useGcpsStore().gcps.filter((g) => g.role !== 'marker' && g.enabled !== false)
    for (const p of [...usePosesStore().poses, ...surveyed]) {
      if (Number.isFinite(p.lon) && Number.isFinite(p.lat)) points.push([p.lon, p.lat])
      else if (projCrs && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        try {
          points.push(projCrs === 'EPSG:4326' ? [p.x, p.y] : transform([p.x, p.y], projCrs, 'EPSG:4326'))
        } catch {
          /* a position outside the CRS's domain adds nothing */
        }
      }
    }
    if (!points.length || !crs) return null
    return projectRasterWindow({
      points,
      toRaster: (lon, lat) => (crs === 'EPSG:4326' ? [lon, lat] : transform([lon, lat], 'EPSG:4326', crs)),
      geoTransform: meta.geoTransform,
      width: meta.width,
      height: meta.height,
      cellBytes: meta.cellBytes,
    })
  }

  async function importRasterNow(file, { forceKind = null, origin = null } = {}) {
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
      ;({ meta, plane } = await parseRasterFile(file, file.name, {
        forceKind,
        previewOnly: true,
        onLog: (m, l, c) => log(m, l, c),
      }))
      // Too large for one plane: read the window over the project's images instead.
      if (meta?.tooLarge) {
        const fit = await rasterWindowFor(meta)
        if (!fit?.window) {
          throw new Error(
            `${meta.message} ` +
              (fit?.reason === 'outside'
                ? "The project's images and GCPs lie outside it."
                : 'The project has no image positions or GCPs yet to crop it to; import them first, or crop the raster.'),
          )
        }
        const { window, factor } = fit
        const cell = Math.abs(meta.geoTransform.scaleX)
        log(
          `Reference raster ${file.name}: ${meta.width.toLocaleString()} × ${meta.height.toLocaleString()} cells ` +
            `is too large for one plane — reading the ${(window[2] - window[0]).toLocaleString()} × ` +
            `${(window[3] - window[1]).toLocaleString()} window over the project's images and GCPs (half ` +
            'their extent around them, at least 1 km)' +
            (factor > 1
              ? `, at ${factor}× its cell size (${(cell * factor).toPrecision(3)} instead of ${cell.toPrecision(3)}) ` +
                'to fit one buffer'
              : ''),
          factor > 1 ? 'warn' : 'info',
          'Import',
        )
        ;({ meta, plane } = await parseRasterFile(file, file.name, {
          forceKind,
          previewOnly: true,
          window,
          factor,
          onLog: (m, l, c) => log(m, l, c),
        }))
      }
    } catch (err) {
      removePending()
      log(`Reference raster: could not read ${file.name} — ${err?.message ?? err}`, 'error', 'Import')
      return null
    }

    const record = {
      ...meta,
      id,
      importedAt: Date.now(),
      // Fetched by the app (Find GCPs ▸ Sentinel-2), not imported: it cannot be a
      // misrouted source photo, so the sidebar offers no "Convert to source image".
      ...(origin ? { origin } : {}),
      // Which style the persisted full-res plane was composed with. A restyle
      // updates `style` but not this, marking the plane stale so it re-decodes
      // lazily — see setRasterStyle / ensureRasterLoaded.
      planeStyleStamp: styleStamp(meta.style),
      // Declared vertical accuracy (σ, in the raster's vertical unit). Null until
      // the user sets it — and a GCP Z filled from a raster with no declared
      // accuracy must NOT claim survey-grade σ, so the fill action refuses.
      horizontalAccuracy: null,
      verticalAccuracy: null,
      vOffset: 0,
      // Map display (A-4). Off by default: importing a reference dataset is not the
      // same as wanting it drawn over the project, and a large ortho appearing
      // unbidden under the tie-points is a surprise, not a feature.
      visible: false,
      opacity: 1,
    }
    delete record.plane

    // Resolve the raster's own CRS so `sampleAt` can reproject the query into it
    // later. Done once here, at import, rather than on every sample.
    if (record.crs) {
      if (!(await resolveRasterCrs(record))) {
        log(
          `Reference raster: CRS ${record.crs} could not be resolved — sampling and map ` +
            'display are disabled until its projection definition becomes available.',
          'warn',
          'Import',
        )
      }
    } else {
      log(`Reference raster ${record.name}: no CRS in the GeoTIFF — assuming the project CRS`, 'warn', 'Import')
    }

    // Parsing and CRS resolution may take seconds. A lifecycle change clears
    // this store; never let the old operation repopulate or persist into the
    // newly active project.
    if (projects.currentProjectId !== projectId) {
      removePending()
      log(`Reference raster: ${file.name} finished after the project changed — import discarded`, 'warn', 'Import')
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
    // Preview is already visible; serialize optional conversion jobs in the background.
    const prepared = displayFile(record.id)
    activeImports.add(prepared)
    prepared
      .catch((err) => log(`Raster tiled display unavailable: ${err.message}`, 'warn', 'Import'))
      .finally(() => activeImports.delete(prepared))

    if (isPersisting()) {
      if (plane)
        await opfs
          .saveExternalPlane(projectId, record.id, plane.buffer)
          .catch((err) => log(`Reference raster save failed — ${err?.message ?? err}`, 'error', 'Import'))
      // Keep the original file: it's the source of truth a kind flip re-decodes
      // from, and (A-7) what "cache locally" would materialise.
      await opfs
        .saveExternalSource(projectId, record.id, file)
        .catch((err) => log(`Reference raster source save failed — ${err?.message ?? err}`, 'warn', 'Import'))
      await save()
    }

    log(
      `Reference raster: added "${record.name}" (${record.kind.toUpperCase()}, ` +
        `${record.width}×${record.height}, ${record.crs || 'no CRS'})`,
      'success',
      'Import',
    )
    if (mixedVerticalDatums.value) {
      log(
        'Reference rasters declare different vertical datums — elevations from them ' +
          "are not directly comparable. Check each dataset's vertical datum.",
        'warn',
        'Import',
      )
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
    const rgba = plane == null ? null : plane instanceof Uint8Array ? plane : new Uint8Array(plane)
    // An ortho has no scalar value plane — sampleAt returns null and callers use
    // the geometry helpers (worldToPixel) plus `rgba()` for colour.
    return createFlatRasterSource(meta, null, {
      rgba,
      previewDataUrl: meta.previewDataUrl,
      readRawWindow: (rect, _level, opts = {}) => readRasterWindow(meta.id, { rect, ...opts }),
    })
  }

  async function readRasterWindow(id, options = {}) {
    const projectId = projects.currentProjectId
    const file = await originalFile(id)
    if (!file || projectId !== projects.currentProjectId)
      throw new Error('The original reference raster is unavailable')
    return workerReadRasterWindow(file, options)
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
  // corrupt (an RGBA plane only: a DEM's plane holds raw elevations, which no
  // style changes, so it never goes stale): `setRasterStyle` repaints the preview immediately and defers the
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

    // An ortho imported since tiled display landed has NO plane by design: the
    // retained original is authoritative and drawn as GPU tiles, and raw windows
    // are read from it on demand. Its source is plane-less — never "missing data",
    // and a restyle must not trigger a full-resolution RGBA decode to rebuild a
    // plane it never had.
    const planeless = meta.kind === 'ortho' && !(await opfs.hasExternalPlane(projects.currentProjectId, id))
    if (planeless) {
      const source = buildSource(meta, null)
      setSource(id, source)
      return source
    }

    const wanted = styleStamp(meta.style)
    if (meta.kind !== 'dem' && (meta.planeStyleStamp ?? wanted) !== wanted) {
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
        log(
          `Reference raster "${meta.name}": pixel data is ${buf.byteLength} bytes, ` +
            `expected ${expected} — discarding as corrupt.`,
          'error',
          'Import',
        )
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
      log(
        `Reference raster "${meta.name}": restyled, but the original file is no longer ` +
          'stored, so full-resolution pixels cannot be rebuilt. Re-import it to sample it.',
        'warn',
        'Import',
      )
      return null
    }
    try {
      const buffer = await file.arrayBuffer()
      const { plane } = await parseRasterFile(buffer, meta.name, {
        forceKind: meta.kind,
        // A raster read as a window over the project (importRasterNow) re-reads that window.
        window: meta.window ? [meta.window.x0, meta.window.y0, meta.window.x1, meta.window.y1] : null,
        factor: meta.window?.factor ?? 1,
        // A plain copy: the record is reactive, and a proxy cannot be posted to the worker.
        style: JSON.parse(JSON.stringify(meta.style ?? null)),
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
      log(
        `Reference raster "${meta.name}": rebuilding full-resolution pixels failed — ` + `${err?.message ?? err}`,
        'error',
        'Import',
      )
      return null
    }
  }

  return {
    buildSource,
    ensureRasterLoaded,
    flushPendingWork,
    importRaster,
    readRasterWindow,
    setSource,
  }
}
