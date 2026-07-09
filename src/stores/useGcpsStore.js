import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, transform } from '../core/crs.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// Default measurement accuracies for a new GCP.
//   x / y / z    — per-axis accuracy of the ground coordinates, in project-CRS units (e.g. metres)
//   imgX / imgY  — accuracy of the image observations (marker projections), in pixels
const DEFAULT_ACCURACY_X   = 1.0
const DEFAULT_ACCURACY_Y   = 1.0
const DEFAULT_ACCURACY_Z   = 1.0
const DEFAULT_ACCURACY_IMG = 1.0

// Project-scoped store: ground control points, stored in the project's working CRS.
//
// Reads the image list (to resolve observation image names → ids) from the images
// store and the project CRS / persistence flags from the projects store.
export const useGcpsStore = registerProjectStore(defineStore('gcps', () => {
  const { log } = useLog()
  const imagesStore = useImagesStore()
  const projects = useProjectsStore()

  // [{ id, name, x, y, z, accuracyX, accuracyY, accuracyZ, accuracyImgX, accuracyImgY,
  //    observations: [{ imageId, imageName, px, py }], enabled }]
  // `enabled` = ignored entirely (excluded from georeference/BA + accuracy report).
  const gcps = ref([])

  // Backfill accuracy fields on GCPs loaded from older saved projects.
  // (Pre-split `accuracyAbs`/`accuracyXY` seed the per-axis ground values; the
  // former single `accuracyRel` seeds both image axes; `role` is dropped.)
  function normalize(g) {
    if (g.accuracyX    == null) g.accuracyX    = g.accuracyXY ?? g.accuracyAbs ?? DEFAULT_ACCURACY_X
    if (g.accuracyY    == null) g.accuracyY    = g.accuracyXY ?? g.accuracyAbs ?? DEFAULT_ACCURACY_Y
    if (g.accuracyZ    == null) g.accuracyZ    = g.accuracyAbs ?? DEFAULT_ACCURACY_Z
    if (g.accuracyImgX == null) g.accuracyImgX = g.accuracyRel ?? DEFAULT_ACCURACY_IMG
    if (g.accuracyImgY == null) g.accuracyImgY = g.accuracyRel ?? DEFAULT_ACCURACY_IMG
    delete g.accuracyAbs
    delete g.accuracyXY
    delete g.accuracyRel
    delete g.role
    return g
  }

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  async function save() {
    if (!isPersisting()) return
    await opfs.saveGcps(projects.currentProjectId, {
      crs: projects.currentCrs,
      gcps: gcps.value,
    }).catch((err) => log(`GCP save failed — ${err?.message ?? err}`, 'error', 'GCP'))
  }

  // Resolve an observation's image name to an in-memory image id (case-insensitive,
  // tolerant of extension differences).
  function resolveImageId(imageName) {
    if (!imageName) return null
    const lc = imageName.toLowerCase()
    const base = lc.replace(/\.[^.]+$/, '')
    const hit = imagesStore.images.find((img) => {
      const n = img.name.toLowerCase()
      return n === lc || n.replace(/\.[^.]+$/, '') === base
    })
    return hit?.id ?? null
  }

  // Add parsed GCPs (given in `sourceCrs`), transforming positions into the project CRS.
  async function addGcps(rawGcps, sourceCrs) {
    const projCrs = projects.currentCrs
    // If either CRS can't be resolved, transform() below would throw mid-loop —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`GCP import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'GCP')
      return 0
    }

    let added = 0
    for (const raw of rawGcps) {
      const [x, y, z] = transform([raw.x, raw.y, raw.z ?? 0], sourceCrs, projCrs)
      const existing = gcps.value.find((g) => g.name === raw.name)
      const observations = (raw.observations || []).map((o) => ({
        imageId: resolveImageId(o.imageName),
        imageName: o.imageName,
        px: o.px,
        py: o.py,
      }))
      if (existing) {
        // Merge: update position + append observations we don't already have
        // (re-importing the same file must not duplicate observations).
        existing.x = x; existing.y = y; existing.z = raw.z != null ? z : existing.z
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
          x, y, z: raw.z != null ? z : null,
          accuracyX:    DEFAULT_ACCURACY_X,
          accuracyY:    DEFAULT_ACCURACY_Y,
          accuracyZ:    DEFAULT_ACCURACY_Z,
          accuracyImgX: DEFAULT_ACCURACY_IMG,
          accuracyImgY: DEFAULT_ACCURACY_IMG,
          observations,
          enabled: true,
        })
        added++
      }
    }
    const obsCount = rawGcps.reduce((n, g) => n + (g.observations?.length || 0), 0)
    log(`GCPs imported: ${added} point(s)${obsCount ? `, ${obsCount} observation(s)` : ''} (from ${sourceCrs})`, 'success', 'GCP')
    await save()
    return added
  }

  // Manually create a blank GCP (no import needed) — position defaults to the
  // origin and is edited afterward in the table; observations are marked
  // interactively via setObservation. Returns the new GCP's id.
  function addGcp() {
    const n = gcps.value.length + 1
    const id = crypto.randomUUID()
    gcps.value.push({
      id, name: `GCP ${n}`, x: 0, y: 0, z: 0,
      accuracyX: DEFAULT_ACCURACY_X, accuracyY: DEFAULT_ACCURACY_Y, accuracyZ: DEFAULT_ACCURACY_Z,
      accuracyImgX: DEFAULT_ACCURACY_IMG, accuracyImgY: DEFAULT_ACCURACY_IMG,
      observations: [], enabled: true,
    })
    log(`GCP added: ${gcps.value[gcps.value.length - 1].name}`, 'success', 'GCP')
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

  // Update one ground-position axis ('x' | 'y' | 'z') of a GCP, in project-CRS
  // units. Empty/invalid input is ignored (keeps the previous value) rather
  // than silently persisting a NaN.
  function setGcpPosition(id, axis, value) {
    const g = gcps.value.find((x) => x.id === id)
    if (!g || (axis !== 'x' && axis !== 'y' && axis !== 'z')) return
    const num = Number(value)
    if (!Number.isFinite(num)) return
    g[axis] = num
    save()
  }

  // Update one accuracy field of a GCP: ground 'x'|'y'|'z' (CRS units) or image
  // 'imgx'|'imgy' (pixels). Empty/invalid input falls back to that field's
  // default so we never persist a NaN.
  const ACCURACY_FIELDS = {
    x:    { prop: 'accuracyX',    def: DEFAULT_ACCURACY_X   },
    y:    { prop: 'accuracyY',    def: DEFAULT_ACCURACY_Y   },
    z:    { prop: 'accuracyZ',    def: DEFAULT_ACCURACY_Z   },
    imgx: { prop: 'accuracyImgX', def: DEFAULT_ACCURACY_IMG },
    imgy: { prop: 'accuracyImgY', def: DEFAULT_ACCURACY_IMG },
  }
  function setGcpAccuracy(id, kind, value) {
    const field = ACCURACY_FIELDS[kind]
    const g = gcps.value.find((x) => x.id === id)
    if (!field || !g) return
    const num = Number(value)
    g[field.prop] = Number.isFinite(num) && num > 0 ? num : field.def
    save()
  }

  function removeGcp(id) {
    const idx = gcps.value.findIndex((g) => g.id === id)
    if (idx === -1) return
    gcps.value.splice(idx, 1)
    save()
  }

  // Upsert a pixel observation for `imageId` on a GCP (replacing any existing
  // observation for that image) — used by interactive click-to-mark.
  function setObservation(gcpId, imageId, imageName, px, py) {
    const g = gcps.value.find((x) => x.id === gcpId)
    if (!g) return
    const existing = g.observations.find((o) => o.imageId === imageId)
    if (existing) { existing.px = px; existing.py = py; existing.imageName = imageName }
    else g.observations.push({ imageId, imageName, px, py })
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
    if (purge && isPersisting()) opfs.deleteGcps(projects.currentProjectId).catch(() => {})
  }

  // Project-store contract: load this project's GCPs, re-projecting if the stored
  // CRS differs from the project's current working CRS.
  async function restore({ projectId, projectData }) {
    const projectCrs = projectData?.crs
    gcps.value = []
    const data = await opfs.loadGcps(projectId)
    if (!data?.gcps?.length) return
    // Stored CRS may differ from the current project CRS (e.g. CRS changed elsewhere).
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      gcps.value = data.gcps.map((g) => {
        const [x, y, z] = transform([g.x, g.y, g.z ?? 0], data.crs, projectCrs)
        return normalize({ ...g, x, y, z: g.z != null ? z : null })
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
      const [x, y, z] = transform([g.x, g.y, g.z ?? 0], fromCrs, toCrs)
      return { ...g, x, y, z: g.z != null ? z : null }
    })
    await save()
    log(`GCPs re-projected to ${toCrs}`, 'info', 'GCP')
  }

  return {
    gcps,
    addGcps,
    addGcp,
    setGcpName,
    setGcpPosition,
    setGcpAccuracy,
    setObservation,
    removeObservation,
    removeGcp,
    reprojectGcps,
    // project-store contract
    clear,
    restore,
  }
}))
