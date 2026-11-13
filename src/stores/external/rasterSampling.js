// The external store's sampling: heights from a reference DEM at project coordinates
// (the query is reprojected, the raster keeps its CRS: useExternalStore.js ▸ invariant
// 2), a sampler for many points, GCP picking and the raster under a map position.
//
// Moved verbatim from the store: everything it shares comes in by name.

import { ensureProjection, transform, transformer, isGeographic, metresToCrsUnits } from '../../core/crs.js'
import { rasterBounds } from '../../core/io/rasterSample.js'
import { referencePick } from '../../core/sfm/referenceGcps.js'
import { heightShifter } from '../../core/verticalDatum.js'

export function createRasterSampling({
  currentCrs,
  defaultDem,
  ensureRasterLoaded,
  mapRasters,
  rasterById,
  resolveRasterCrs,
  sources,
}) {
  // ── sampling ───────────────────────────────────────────────────────────────
  // Sample a reference DEM at a point given in the **project** CRS. Reprojects
  // the query into the raster's native CRS (invariant 2) and returns the value,
  // plus the declared vertical accuracy so callers never have to invent a σ.
  // `datum`: the vertical datum the caller wants the height in. When the DEM's
  // converts to it (ellipsoidal ↔ EGM96 ↔ EGM2008, core/verticalDatum.js) the
  // geoid separation there is applied and reported as `shift`; otherwise the
  // height stays in the DEM's own datum, which `datum` says.
  // → { z, accuracy, datum, shift?, sourceDatum?, rasterId, rasterName } | null
  async function sampleReferenceDem(x, y, { rasterId = null, datum = null } = {}) {
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
    const hit = {
      z: raw + (meta.vOffset || 0),
      accuracy: meta.verticalAccuracy ?? null,
      datum: meta.verticalDatum || 'unknown',
      rasterId: meta.id,
      rasterName: meta.name,
    }
    if (!datum || datum === 'unknown' || datum === hit.datum) return hit
    const shiftAt = await heightShifter(hit.datum, datum)
    const lonLat = shiftAt && toLonLat(x, y)
    if (!lonLat) return hit
    const shift = shiftAt(...lonLat)
    return { ...hit, z: hit.z + shift, datum, shift, sourceDatum: hit.datum }
  }

  // Project CRS → WGS 84 lon/lat, for the geoid grids; null when it fails.
  function toLonLat(x, y) {
    if (!currentCrs.value || currentCrs.value === 'EPSG:4326') return [x, y]
    try {
      return transform([x, y], currentCrs.value, 'EPSG:4326')
    } catch {
      return null
    }
  }

  // The same sampling as `sampleReferenceDem`, prepared once for a caller that
  // queries the raster many times (Quality Report ▸ Products ▸ DEM vs reference):
  // CRS resolved, plane hydrated and the transform built up front, then a
  // synchronous `sample(x, y)` per point. `fromCrs` is the CRS of the query
  // points — a computed DEM's own frame, which outlives a later project-CRS
  // change. A raster with no declared CRS is read in `fromCrs`, as in
  // `toRasterCoords`. Throws with a user-facing reason when it cannot sample.
  // → { meta, sample(x, y) → z | null, conversion: { from, to, min, max } | null }
  //   opts.strict — the cell containing a point must have a height: a reference
  //                 hole, or a point off the raster, reads null instead of a
  //                 neighbour's value (DEM of difference volumes count it unmeasured)
  //   opts.datum  — heights in this vertical datum when the reference's converts
  //                 to it (the geoid separation per point); `conversion` records
  //                 the range of the shift applied
  async function referenceDemSampler(rasterId, fromCrs, { strict = false, datum = null } = {}) {
    const meta = rasterById(rasterId)
    if (!meta || meta.kind !== 'dem') throw new Error('The reference DEM is no longer in the project')
    if (meta.crsUnresolved && !(await resolveRasterCrs(meta))) {
      throw new Error(`The reference DEM's CRS (${meta.crs}) could not be resolved`)
    }
    let toRaster = (x, y) => [x, y]
    if (meta.crs && meta.crs !== fromCrs) {
      if (!fromCrs || fromCrs === 'local') {
        throw new Error(
          "The DEM is in the model frame, so it has no position in the reference DEM's CRS — georeference the model and rebuild the DEM",
        )
      }
      await ensureProjection(fromCrs)
      toRaster = transformer(fromCrs, meta.crs)
    }
    const source = await ensureRasterLoaded(meta.id)
    if (!source) throw new Error(`The pixel data of "${meta.name}" is unavailable — re-import it`)
    const vOffset = meta.vOffset || 0
    const sampleOpts = strict ? { strict: true } : undefined
    const refDatum = meta.verticalDatum || 'unknown'
    let shiftAt = null,
      toLonLatFrom = null,
      conversion = null
    if (
      datum &&
      datum !== 'unknown' &&
      refDatum !== 'unknown' &&
      datum !== refDatum &&
      fromCrs &&
      fromCrs !== 'local'
    ) {
      shiftAt = await heightShifter(refDatum, datum)
      if (shiftAt) {
        await ensureProjection(fromCrs)
        toLonLatFrom = fromCrs === 'EPSG:4326' ? (x, y) => [x, y] : transformer(fromCrs, 'EPSG:4326')
        conversion = { from: refDatum, to: datum, min: Infinity, max: -Infinity }
      }
    }
    return {
      meta,
      conversion,
      sample(x, y) {
        let rx, ry
        try {
          ;[rx, ry] = toRaster(x, y)
        } catch {
          return null
        }
        const raw = source.sampleAt(rx, ry, sampleOpts)
        if (raw == null) return null
        if (!shiftAt) return raw + vOffset
        let shift
        try {
          shift = shiftAt(...toLonLatFrom(x, y))
        } catch {
          return null
        }
        if (shift < conversion.min) conversion.min = shift
        if (shift > conversion.max) conversion.max = shift
        return raw + vOffset + shift
      },
    }
  }

  // A GCP position read off a reference raster tab (A-5): the native pixel-edge
  // point (col, row) of raster `id` in project coordinates, σ XY from the pixel
  // size as drawn (core/sfm/referenceGcps.js referencePick), and the height of a
  // reference DEM there — this raster when it is one, else the default DEM — in
  // `datum` when it converts. The height comes back with its declared accuracy;
  // without one the caller must not use it (the Fill Z rule). Throws with a
  // user-facing reason.
  // → { x, y, gsd, sigma, rasterName, dem: { z, accuracy, datum, rasterName } | null }
  async function pickGroundControl(id, col, row, { displayFactor = 1, datum = null } = {}) {
    const meta = rasterById(id)
    if (!meta) throw new Error('The reference raster is no longer in the project')
    if (meta.crsUnresolved && !(await resolveRasterCrs(meta))) {
      throw new Error(`The CRS of "${meta.name}" (${meta.crs}) could not be resolved`)
    }
    if (meta.crs && currentCrs.value) await ensureProjection(currentCrs.value)
    const toProject = ([x, y]) => toProjectCoords(meta, x, y) ?? [NaN, NaN]
    const pick = referencePick(meta, col, row, {
      toProject,
      displayFactor,
      geographic: isGeographic(currentCrs.value),
      declared: metresToCrsUnits(meta.horizontalAccuracy, currentCrs.value),
    })
    if (!Number.isFinite(pick.x) || !Number.isFinite(pick.y)) {
      throw new Error(`That point of "${meta.name}" has no position in ${currentCrs.value}`)
    }
    const dem = await sampleReferenceDem(pick.x, pick.y, { datum, ...(meta.kind === 'dem' ? { rasterId: id } : {}) })
    return { ...pick, rasterName: meta.name, dem }
  }

  // Synchronous point probe for the map status bar: the topmost on-map raster
  // whose extent covers this **project-CRS** point. Deliberately reads only
  // already-hydrated planes (invariant 1) — a cursor move must never kick off the
  // lazy load of a hundreds-of-MB tile, so an un-hydrated hit reports
  // `loaded:false` and the caller offers to load it.
  // → { id, name, kind, loaded, value } | null
  // `skip`: ids not to answer for (layers the Layers panel hides), or null.
  function probeRasterAt(x, y, skip = null) {
    const list = mapRasters.value
    for (let i = list.length - 1; i >= 0; i--) {
      const meta = list[i]
      if (skip?.has(meta.id)) continue
      const coords = toRasterCoords(meta, x, y)
      if (!coords) continue
      const [rx, ry] = coords
      const b = rasterBounds({ width: meta.width, height: meta.height, geoTransform: meta.geoTransform })
      if (!b) continue
      const [minX, minY, maxX, maxY] = b
      if (rx < minX || rx > maxX || ry < minY || ry > maxY) continue
      const source = sources.value.get(meta.id)
      if (!source) return { id: meta.id, name: meta.name, kind: meta.kind, loaded: false, value: null }
      // The cell under the cursor, not an interpolated/neighbour value: a nodata
      // hole must read as no data on the map too.
      const raw = meta.kind === 'dem' ? source.cellValueAt(rx, ry) : null
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

  return {
    pickGroundControl,
    probeRasterAt,
    referenceDemSampler,
    sampleReferenceDem,
    toProjectCoords,
    toRasterCoords,
  }
}
