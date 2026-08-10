import { ref, watch, computed } from 'vue'
import { defineStore } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, isGeographic, localMetricFrame, metresToCrsUnits, transform } from '../core/crs.js'
import { confidenceToSigma, precisionFromGcp, reprojectGcpWithAccuracy } from '../core/gcpAccuracy.js'
import { hasGcpElevation, normalizeGcpRole } from '../core/io/gcp.js'
import { makeNameResolver } from '../core/io/nameMatch.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// Default accuracy of image observations (marker projections), in pixels.
// Ground-coordinate accuracy has no implicit default: it must be declared.
const DEFAULT_ACCURACY_IMG = 1.0

// Project-scoped store: ground control points, stored in the project's working CRS.
//
// Reads the image list (to resolve observation image names → ids) from the images
// store and the project CRS / persistence flags from the projects store.
export const useGcpsStore = registerProjectStore(defineStore('gcps', () => {
  const { log } = useLog()
  const imagesStore = useImagesStore()
  const projects = useProjectsStore()

  // [{ id, name, role:'control'|'check', x, y, z, accuracyX, accuracyY,
  //    accuracyZ, correlations, provenance/datum, accuracyImgX, accuracyImgY,
  //    observations: [{ imageId, imageName, px, py, accuracyX, accuracyY }], enabled }]
  // `role` and `enabled` are orthogonal: an enabled checkpoint is measured but
  // never enters georeferencing or BA; disabled points enter neither solve nor report.
  const gcps = ref([])
  const importDefaults = ref({ accuracies: { x: null, y: null, z: null },
    imageAccuracies: { x: 1, y: 1 }, settings: { preset: 'unknown', convention: '1sigma', unit: 'metres', verticalDatum: 'unknown' } })

  // Canonicalize current-schema values loaded from persistence. Missing or
  // invalid ground uncertainty stays unknown and therefore cannot constrain a
  // solve; no compatibility defaults are inferred from retired fields.
  function normalize(g) {
    const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0
      ? Number(value) : null
    const correlation = (value) => Number.isFinite(Number(value))
      ? Math.max(-0.999, Math.min(0.999, Number(value))) : 0

    g.role = normalizeGcpRole(g.role)
    g.accuracyX = positive(g.accuracyX)
    g.accuracyY = positive(g.accuracyY)
    g.accuracyZ = positive(g.accuracyZ)
    g.accuracyImgX = positive(g.accuracyImgX) ?? DEFAULT_ACCURACY_IMG
    g.accuracyImgY = positive(g.accuracyImgY) ?? DEFAULT_ACCURACY_IMG
    g.accuracyConvention ??= '1sigma'
    g.verticalDatum ??= 'unknown'
    g.correlationXY = correlation(g.correlationXY)
    g.correlationXZ = correlation(g.correlationXZ)
    g.correlationYZ = correlation(g.correlationYZ)
    g.accuracyStatus = precisionFromGcp(g)
      ? (g.accuracyStatus && g.accuracyStatus !== 'unknown' ? g.accuracyStatus : 'declared')
      : 'unknown'
    for (const o of g.observations || []) {
      o.accuracyX = positive(o.accuracyX) ?? g.accuracyImgX
      o.accuracyY = positive(o.accuracyY) ?? g.accuracyImgY
    }
    return g
  }

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  async function save() {
    if (!isPersisting()) return
    await opfs.saveGcps(projects.currentProjectId, {
      crs: projects.currentCrs,
      gcps: gcps.value,
      importDefaults: importDefaults.value,
    }).catch((err) => log(`GCP save failed — ${err?.message ?? err}`, 'error', 'GCP'))
  }

  // Name → image-id matching is shared with poses / footprints / COLMAP import
  // (core/io/nameMatch.js). Indexed once per image-list change, so a full
  // reconcile is O(observations + images) rather than a scan per observation.
  const resolveImageId = computed(() => makeNameResolver(imagesStore.images))

  // Re-resolve every observation's `imageId` against the current image list.
  // Observations imported/marked before their image was loaded carry a null
  // `imageId` (image doesn't exist yet); this backfills them once the image
  // arrives, and drops the id again if that image is later removed. Keeps the
  // stored `imageId` authoritative so the sidebar can gate the jump-to-image
  // link on "image actually exists". Runs on every image-list change.
  function reconcileObservationImageIds() {
    let changed = false
    const resolve = resolveImageId.value
    for (const g of gcps.value) {
      for (const o of g.observations || []) {
        const resolved = resolve(o.imageName)
        if (resolved !== o.imageId) { o.imageId = resolved; changed = true }
      }
    }
    if (changed) save()
  }
  // The image list changes identity on add/remove (and names on rename); re-run
  // resolution so GCP links track it.
  watch(
    () => imagesStore.images.map((img) => `${img.id}:${img.name}`).join('|'),
    () => reconcileObservationImageIds(),
  )

  // Add parsed GCPs (given in `sourceCrs`), transforming positions into the project CRS.
  async function addGcps(rawGcps, sourceCrs, defaultAccuracies = {}, accuracySettings = {}, defaultImageAccuracies = {}) {
    const projCrs = projects.currentCrs
    const imageDefaults = {
      x: Number.isFinite(Number(defaultImageAccuracies.x)) && Number(defaultImageAccuracies.x) > 0 ? Number(defaultImageAccuracies.x) : 1,
      y: Number.isFinite(Number(defaultImageAccuracies.y)) && Number(defaultImageAccuracies.y) > 0 ? Number(defaultImageAccuracies.y) : 1,
    }
    // If either CRS can't be resolved, transform() below would throw mid-loop —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`GCP import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'GCP')
      return 0
    }
    importDefaults.value = {
      accuracies: { x: defaultAccuracies.x ?? null, y: defaultAccuracies.y ?? null, z: defaultAccuracies.z ?? null },
      imageAccuracies: imageDefaults,
      settings: { preset: accuracySettings.preset ?? 'custom', convention: accuracySettings.convention ?? '1sigma',
        unit: accuracySettings.unit ?? 'project', verticalDatum: accuracySettings.verticalDatum ?? 'unknown' },
    }

    let added = 0, unconstrained = 0
    const convention = accuracySettings.convention ?? '1sigma'
    const unit = accuracySettings.unit ?? 'project'
    const importedAccuracy = (value, fallback = null, axis = 'x') => {
      const sigma = confidenceToSigma(value, convention, axis)
      return sigma ?? fallback
    }
    const defaults = {
      x: importedAccuracy(defaultAccuracies.x, null, 'x'),
      y: importedAccuracy(defaultAccuracies.y, null, 'y'),
      z: importedAccuracy(defaultAccuracies.z, null, 'z'),
    }
    const toProjectAccuracy = (raw, values) => {
      const base = {
        x: raw.x, y: raw.y, z: raw.z,
        accuracyX: values.x, accuracyY: values.y, accuracyZ: values.z,
        correlationXY: raw.correlationXY ?? 0,
        correlationXZ: raw.correlationXZ ?? 0,
        correlationYZ: raw.correlationYZ ?? 0,
      }
      if (![values.x, values.y, values.z].every((v) => Number.isFinite(v) && v > 0)) return base
      if (unit === 'source') return reprojectGcpWithAccuracy(base, sourceCrs, projCrs)
      if (unit === 'metres') {
        if (isGeographic(projCrs)) {
          const [lon, lat] = transform([raw.x, raw.y], sourceCrs, projCrs)
          return reprojectGcpWithAccuracy({ ...base, x: 0, y: 0 }, localMetricFrame(lon, lat), projCrs)
        }
        return { ...base,
          accuracyX: metresToCrsUnits(values.x, projCrs),
          accuracyY: metresToCrsUnits(values.y, projCrs),
          accuracyZ: metresToCrsUnits(values.z, projCrs) }
      }
      return base
    }
    for (const raw of rawGcps) {
      const [x, y, z] = transform([raw.x, raw.y, raw.z ?? 0], sourceCrs, projCrs)
      const values = {
        x: importedAccuracy(raw.accuracyX, defaults.x, 'x'),
        y: importedAccuracy(raw.accuracyY, defaults.y, 'y'),
        z: importedAccuracy(raw.accuracyZ, defaults.z, 'z'),
      }
      const accuracy = toProjectAccuracy(raw, values)
      const hasAccuracy = precisionFromGcp(accuracy) != null
      if (!hasAccuracy) unconstrained++
      const hasExplicitAccuracy = [raw.accuracyX, raw.accuracyY, raw.accuracyZ].some((v) => v != null)
      const existing = gcps.value.find((g) => g.name === raw.name)
      const observations = (raw.observations || []).map((o) => ({
        imageId: resolveImageId.value(o.imageName),
        imageName: o.imageName,
        px: o.px,
        py: o.py,
        accuracyX: Number.isFinite(o.accuracyX) && o.accuracyX > 0 ? o.accuracyX : imageDefaults.x,
        accuracyY: Number.isFinite(o.accuracyY) && o.accuracyY > 0 ? o.accuracyY : imageDefaults.y,
      }))
      if (existing) {
        // Merge: update position + append observations we don't already have
        // (re-importing the same file must not duplicate observations).
        existing.x = x; existing.y = y; existing.z = raw.z != null ? z : existing.z
        existing.role = normalizeGcpRole(raw.role ?? existing.role)
        // Only explicit per-row values replace existing accuracies. Import-wide
        // fallbacks are for new points and must not erase later manual edits.
        if (raw.accuracyX != null) existing.accuracyX = accuracy.accuracyX
        if (raw.accuracyY != null) existing.accuracyY = accuracy.accuracyY
        if (raw.accuracyZ != null) existing.accuracyZ = accuracy.accuracyZ
        if ([raw.accuracyX, raw.accuracyY, raw.accuracyZ].some((v) => v != null)) {
          existing.correlationXY = accuracy.correlationXY ?? 0
          existing.correlationXZ = accuracy.correlationXZ ?? 0
          existing.correlationYZ = accuracy.correlationYZ ?? 0
          existing.accuracyStatus = hasAccuracy ? 'declared' : 'unknown'
        }
        if (accuracySettings.verticalDatum) existing.verticalDatum = accuracySettings.verticalDatum
        for (const o of observations) {
          const dup = existing.observations.some(
            (e) => e.imageName === o.imageName && e.px === o.px && e.py === o.py,
          )
          if (!dup) existing.observations.push(o)
        }
      } else {
        gcps.value.push({
          id: crypto.randomUUID(),
          name: raw.name,
          role: normalizeGcpRole(raw.role),
          x, y, z: raw.z != null ? z : null,
          accuracyX: accuracy.accuracyX, accuracyY: accuracy.accuracyY, accuracyZ: accuracy.accuracyZ,
          correlationXY: accuracy.correlationXY ?? 0,
          correlationXZ: accuracy.correlationXZ ?? 0,
          correlationYZ: accuracy.correlationYZ ?? 0,
          accuracyStatus: hasAccuracy ? (hasExplicitAccuracy || accuracySettings.preset === 'custom'
            ? 'declared' : `preset:${accuracySettings.preset ?? 'custom'}`) : 'unknown',
          accuracyConvention: '1sigma',
          verticalDatum: accuracySettings.verticalDatum ?? 'unknown',
          accuracyImgX: imageDefaults.x,
          accuracyImgY: imageDefaults.y,
          observations,
          enabled: true,
        })
        added++
      }
    }
    const obsCount = rawGcps.reduce((n, g) => n + (g.observations?.length || 0), 0)
    log(`GCPs imported: ${added} point(s)${obsCount ? `, ${obsCount} observation(s)` : ''} (from ${sourceCrs})`, 'success', 'GCP')
    if (unconstrained) log(`${unconstrained} imported GCP(s) have unknown or invalid covariance and will not constrain the solution`,
      'warn', 'GCP')
    await save()
    return added
  }

  // Manually create a blank GCP (no import needed) — horizontal position defaults
  // to the origin while elevation is explicitly missing until entered or filled
  // from a reference DEM. Observations are marked
  // interactively via setObservation. Returns the new GCP's id.
  function addGcp() {
    const n = gcps.value.length + 1
    const id = crypto.randomUUID()
    gcps.value.push({
      id, name: `GCP ${n}`, role: 'control', x: 0, y: 0, z: null,
      accuracyX: null, accuracyY: null, accuracyZ: null,
      correlationXY: 0, correlationXZ: 0, correlationYZ: 0,
      accuracyStatus: 'unknown', accuracyConvention: '1sigma', verticalDatum: 'unknown',
      accuracyImgX: DEFAULT_ACCURACY_IMG, accuracyImgY: DEFAULT_ACCURACY_IMG,
      observations: [], enabled: true,
    })
    log(`Added GCP ${gcps.value[gcps.value.length - 1].name}`, 'success', 'GCP', { channel: 'activity' })
    save()
    return id
  }

  function setGcpName(id, name) {
    const g = gcps.value.find((x) => x.id === id)
    const trimmed = (name ?? '').trim()
    if (!g || !trimmed) return
    g.name = trimmed
    save()
  }

  function setGcpRole(id, role) {
    const g = gcps.value.find((x) => x.id === id)
    if (!g) return
    const next = normalizeGcpRole(role)
    if (g.role === next) return
    g.role = next
    log(`${g.name} is now a ${next === 'check' ? 'checkpoint' : 'control point'}`,
      'info', 'GCP', { channel: 'activity' })
    save()
  }

  function setGcpVerticalDatum(id, verticalDatum) {
    const g = gcps.value.find((x) => x.id === id)
    if (!g || !['unknown', 'ellipsoidal', 'orthometric', 'local'].includes(verticalDatum)) return
    g.verticalDatum = verticalDatum
    save()
  }

  // Update one ground-position axis ('x' | 'y' | 'z') of a GCP, in project-CRS
  // units. Empty/invalid input is ignored (keeps the previous value) rather
  // than silently persisting a NaN.
  function setGcpPosition(id, axis, value) {
    const g = gcps.value.find((x) => x.id === id)
    if (!g || (axis !== 'x' && axis !== 'y' && axis !== 'z')) return
    if (axis === 'z' && String(value ?? '').trim() === '') {
      g.z = null
      save()
      return
    }
    const num = Number(value)
    if (!Number.isFinite(num)) return
    g[axis] = num
    save()
  }

  // Update one accuracy field of a GCP: ground 'x'|'y'|'z' (CRS units) or image
  // 'imgx'|'imgy' (pixels). Empty clears the declaration; invalid numeric input
  // is ignored so we never persist NaN.
  const ACCURACY_FIELDS = {
    x:    { prop: 'accuracyX' },
    y:    { prop: 'accuracyY' },
    z:    { prop: 'accuracyZ' },
    imgx: { prop: 'accuracyImgX' },
    imgy: { prop: 'accuracyImgY' },
  }
  function setGcpAccuracy(id, kind, value) {
    const field = ACCURACY_FIELDS[kind]
    const g = gcps.value.find((x) => x.id === id)
    if (!field || !g) return
    if (String(value ?? '').trim() === '') g[field.prop] = null
    else {
      const num = Number(value)
      if (!(Number.isFinite(num) && num > 0)) return
      g[field.prop] = num
    }
    if (kind === 'x' || kind === 'y' || kind === 'z') {
      g.accuracyStatus = [g.accuracyX, g.accuracyY, g.accuracyZ].every((v) => Number.isFinite(v) && v > 0)
        ? 'declared' : 'unknown'
    }
    save()
  }

  // Include/exclude a GCP from the georeference fit, BA anchoring and the
  // accuracy report. The visible, reversible way to drop a GCP the accuracy
  // table shows to be bad — see CLAUDE.md on why that report never rejects
  // marks on its own.
  function setGcpEnabled(id, enabled) {
    const g = gcps.value.find((x) => x.id === id)
    if (!g) return
    g.enabled = !!enabled
    log(`GCP ${g.name} ${g.enabled ? 'enabled' : 'disabled'}`, 'info', 'GCP', { channel: 'activity' })
    save()
  }

  function removeGcp(id) {
    const idx = gcps.value.findIndex((g) => g.id === id)
    if (idx === -1) return
    const [removed] = gcps.value.splice(idx, 1)
    log(`Removed GCP ${removed.name}`, 'info', 'GCP', { channel: 'activity' })
    save()
  }

  // ── Reference DEM: fill / check GCP elevations ──────────────────────────────
  //
  // The payoff of the external-reference-data feature: a GCP placed on a map has
  // no elevation, and a reference DEM has one everywhere.
  //
  // ⚠ The accuracy is not optional. `accuracyZ` feeds the bundle-adjustment
  // anchor weight and the Horn fit, so a GCP whose Z came off a 30 m COP30 tile
  // but still claims survey-grade σ will quietly dominate both. The reference
  // raster must therefore carry a *declared* vertical accuracy before it can
  // fill anything — we refuse rather than invent one.
  //
  // `sampleDem(x, y)` is injected (useExternalStore.sampleReferenceDem) so this
  // store keeps no dependency on the external store, and resolves to
  // { z, accuracy, datum, rasterName } | null.
  async function fillZFromReferenceDem(sampleDem, { ids = null, overwrite = false } = {}) {
    const targets = gcps.value.filter((g) => (ids ? ids.includes(g.id) : true))
    let filled = 0, skippedHasZ = 0, skippedNoData = 0, refused = 0

    for (const g of targets) {
      // Null means missing; zero is a valid measured sea-level elevation.
      const hasZ = hasGcpElevation(g)
      if (hasZ && !overwrite) { skippedHasZ++; continue }

      const hit = await sampleDem(g.x, g.y)
      if (!hit || hit.z == null) {
        log(`GCP ${g.name}: outside the reference DEM (or on nodata) — Z left unchanged`, 'warn', 'GCP')
        skippedNoData++
        continue
      }
      if (hit.accuracy == null) {
        log(`GCP ${g.name}: reference DEM "${hit.rasterName}" has no declared vertical `
          + 'accuracy, so filling Z would make this GCP claim survey-grade accuracy it '
          + 'does not have. Set the dataset\'s vertical accuracy first.', 'warn', 'GCP')
        refused++
        continue
      }

      const before = g.z
      g.z = hit.z
      g.accuracyZ = hit.accuracy
      g.verticalDatum = hit.datum ?? 'unknown'
      g.accuracyStatus = [g.accuracyX, g.accuracyY, g.accuracyZ].every((v) => Number.isFinite(v) && v > 0)
        ? 'declared' : 'unknown'
      filled++
      log(`GCP ${g.name}: Z ${before == null ? '—' : fmtNum(before)} → ${fmtNum(hit.z)} `
        + `from "${hit.rasterName}" (σ ${hit.accuracy}, ${hit.datum})`, 'info', 'GCP')
      if (hit.datum === 'unknown') {
        log(`GCP ${g.name}: ⚠ that DEM's vertical datum is undeclared — an ellipsoid/geoid `
          + 'mismatch is tens of metres in polar regions.', 'warn', 'GCP')
      }
    }

    log(`Fill Z from reference DEM: ${filled} filled`
      + `${skippedHasZ ? `, ${skippedHasZ} already had Z` : ''}`
      + `${skippedNoData ? `, ${skippedNoData} outside/nodata` : ''}`
      + `${refused ? `, ${refused} refused (no declared vertical accuracy)` : ''}`,
    filled ? 'success' : 'warn', 'GCP')
    if (filled) save()
    return { filled, skippedHasZ, skippedNoData, refused }
  }

  // Non-destructive counterpart: report DEM-minus-GCP per GCP without touching
  // anything. Feeds the Quality Report's reference-DEM section (A-6).
  // → [{ gcpId, name, x, y, gcpZ, demZ, dz, datum, rasterName }]
  async function checkZAgainstReferenceDem(sampleDem, { ids = null } = {}) {
    const targets = gcps.value.filter((g) => (ids ? ids.includes(g.id) : true))
    const rows = []
    for (const g of targets) {
      const hit = await sampleDem(g.x, g.y)
      const demZ = hit?.z ?? null
      const gcpZ = g.z ?? null
      rows.push({
        gcpId: g.id, name: g.name, x: g.x, y: g.y,
        gcpZ, demZ,
        dz: (demZ != null && gcpZ != null) ? demZ - gcpZ : null,
        gcpDatum: g.verticalDatum ?? 'unknown',
        datum: hit?.datum ?? null,
        rasterName: hit?.rasterName ?? null,
      })
      log(`GCP ${g.name}: reference DEM ${demZ == null ? 'no data' : fmtNum(demZ)}`
        + `, GCP ${gcpZ == null ? '—' : fmtNum(gcpZ)}`
        + `${rows.at(-1).dz != null ? `, Δ ${fmtNum(rows.at(-1).dz)}` : ''}`, 'info', 'GCP')
      if (hit?.datum && hit.datum !== 'unknown' && g.verticalDatum && g.verticalDatum !== 'unknown'
          && hit.datum !== g.verticalDatum) {
        log(`GCP ${g.name}: height datum ${g.verticalDatum} differs from reference DEM datum ${hit.datum}`,
          'warn', 'GCP')
      }
    }
    const withDz = rows.filter((r) => r.dz != null)
    if (withDz.length) {
      const mean = withDz.reduce((s, r) => s + r.dz, 0) / withDz.length
      const rms = Math.sqrt(withDz.reduce((s, r) => s + r.dz * r.dz, 0) / withDz.length)
      // Scatter about the mean, i.e. what's left once a constant offset is removed.
      const sd = Math.sqrt(Math.max(0, rms * rms - mean * mean))
      // An offset that dominates the scatter is the ellipsoid-vs-geoid signature:
      // systematic and slowly varying. Worth naming, because a similarity fit
      // can't absorb it but *will* soak it into a scale/tilt error instead.
      const systematic = withDz.length >= 3 && Math.abs(mean) > 2 * sd
      log(`Check Z against reference DEM: ${withDz.length} GCP(s), mean Δ ${fmtNum(mean)}, `
        + `RMS ${fmtNum(rms)}, scatter ${fmtNum(sd)}`
        + `${systematic ? ' — the offset dominates the scatter, which usually means a '
          + 'vertical datum mismatch (ellipsoid vs geoid) rather than DEM error' : ''}`,
      systematic ? 'warn' : 'info', 'GCP')
    }
    return rows
  }

  const fmtNum = (v) => (v == null ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(2) : Number(v.toPrecision(6))))

  // Upsert a pixel observation for `imageId` on a GCP (replacing any existing
  // observation for that image) — used by interactive click-to-mark.
  function setObservation(gcpId, imageId, imageName, px, py) {
    const g = gcps.value.find((x) => x.id === gcpId)
    if (!g) return
    const existing = g.observations.find((o) => o.imageId === imageId)
    if (existing) { existing.px = px; existing.py = py; existing.imageName = imageName }
    else g.observations.push({ imageId, imageName, px, py, accuracyX: g.accuracyImgX, accuracyY: g.accuracyImgY })
    save()
  }

  function setObservationAccuracy(gcpId, imageId, axis, value) {
    const g = gcps.value.find((x) => x.id === gcpId)
    const o = g?.observations?.find((obs) => obs.imageId === imageId)
    if (!o || (axis !== 'x' && axis !== 'y')) return
    const num = Number(value)
    if (!(Number.isFinite(num) && num > 0)) return
    o[axis === 'x' ? 'accuracyX' : 'accuracyY'] = num
    save()
  }

  function removeObservation(gcpId, imageId) {
    const g = gcps.value.find((x) => x.id === gcpId)
    if (!g) return
    const idx = g.observations.findIndex((o) => o.imageId === imageId)
    if (idx === -1) return
    g.observations.splice(idx, 1)
    save()
  }

  // Project-store contract: reset state; only { purge: true } deletes persisted
  // data. A plain clear (project switch/close) must leave OPFS intact — restore
  // reads it back and currentProjectId still points at the project being left.
  function clear({ purge = false } = {}) {
    gcps.value = []
    importDefaults.value = { accuracies: { x: null, y: null, z: null },
      imageAccuracies: { x: 1, y: 1 }, settings: { preset: 'unknown', convention: '1sigma', unit: 'metres', verticalDatum: 'unknown' } }
    if (purge && isPersisting()) opfs.deleteGcps(projects.currentProjectId).catch(() => {})
  }

  // Project-store contract: load this project's GCPs, re-projecting if the stored
  // CRS differs from the project's current working CRS.
  async function restore({ projectId, projectData }) {
    const projectCrs = projectData?.crs
    gcps.value = []
    const data = await opfs.loadGcps(projectId)
    if (data?.importDefaults) importDefaults.value = data.importDefaults
    if (!data?.gcps?.length) return
    // Stored CRS may differ from the current project CRS (e.g. CRS changed elsewhere).
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      gcps.value = data.gcps.map((g) => {
        return normalize(reprojectGcpWithAccuracy(normalize({ ...g }), data.crs, projectCrs))
      })
      await opfs.saveGcps(projectId, { crs: projectCrs, gcps: gcps.value }).catch(() => {})
    } else {
      gcps.value = data.gcps.map(normalize)
    }
    log(`GCPs restored: ${gcps.value.length} point(s)`, 'success', 'GCP')
  }

  // Re-project all stored GCPs when the project CRS changes.
  async function reprojectGcps(fromCrs, toCrs) {
    if (!gcps.value.length || fromCrs === toCrs) { await save(); return }
    await ensureProjection(fromCrs).catch(() => {})
    await ensureProjection(toCrs).catch(() => {})
    gcps.value = gcps.value.map((g) => {
      return reprojectGcpWithAccuracy(g, fromCrs, toCrs)
    })
    await save()
    log(`GCPs re-projected to ${toCrs}`, 'info', 'GCP')
  }

  return {
    gcps,
    importDefaults,
    addGcps,
    addGcp,
    setGcpName,
    setGcpRole,
    setGcpVerticalDatum,
    setGcpPosition,
    setGcpAccuracy,
    setObservation,
    setObservationAccuracy,
    removeObservation,
    removeGcp,
    fillZFromReferenceDem,
    checkZAgainstReferenceDem,
    reprojectGcps,
    // project-store contract
    clear,
    restore,
  }
}))
