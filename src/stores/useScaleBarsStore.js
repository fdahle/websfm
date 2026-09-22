import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { toMetres, LENGTH_UNITS } from '../core/products/scale.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'

// Project-scoped store: **scale bars** — known real-world distances between two
// reproducible points in the reconstruction. They are what gives an
// object-capture project (no GCPs, no CRS, no georeference) a metric unit.
//
// This store owns the EVIDENCE only: what the user measured, persisted to
// `scalebars.json`. The derived fit lives on the other side of the boundary, in
// `reconstruction.json.scaleFit` via `stores/reconstruction/scaling.js` — the
// same split as GCPs (evidence) vs the georeference fit. Keeping them apart is
// what lets a fit go stale (model rebuilt, mark moved) without taking the
// measurements with it.
//
// A bar is `{ id, name, a, b, knownDistanceM, accuracyM, displayUnit, enabled }`
// where each endpoint is `{ kind: 'marker' | 'camera', id }`:
//   marker — a point with image observations and no surveyed position
//            (useGcpsStore, role 'marker'); triangulated in the SfM frame.
//   camera — a registered image; its camera CENTRE is the endpoint. Costs nothing
//            extra (the centre is already known), so a calibrated rig baseline or
//            a surveyed camera pair scales a project with no marking at all.
//
// `knownDistanceM` is always METRES. `displayUnit` records what the user typed in
// (mm/cm/m) so the modal shows the number back the way it was entered — close-range
// users routinely know a dimension in millimetres, and a hand conversion is exactly
// the silent factor-of-1000 this field exists to prevent.
export const useScaleBarsStore = registerProjectStore(defineStore('scaleBars', () => {
  const { log } = useLog()
  const projects = useProjectsStore()

  const bars = ref([])
  let restoreGeneration = 0

  const isPersisting = () => projects.isPersisting

  async function save() {
    if (!isPersisting()) return
    await opfs.saveScaleBars(projects.currentProjectId, { bars: bars.value })
      .catch((err) => log(`Scale bar save failed — ${err?.message ?? err}`, 'error', 'Scale'))
  }

  // Bars that can define a scale. A bar is invalid — never silently dropped — when
  // its endpoints are missing, identical, or its distance/accuracy is not positive.
  // `validateBar` returns the reason so the table can SHOW an unusable bar with
  // its problem instead of quietly omitting it (D5).
  function validateBar(bar) {
    if (!bar?.a?.id || !bar?.b?.id) return 'endpoint missing'
    if (bar.a.kind === bar.b.kind && bar.a.id === bar.b.id) return 'both endpoints are the same point'
    if (!Number.isFinite(bar.knownDistanceM) || bar.knownDistanceM <= 0) return 'distance must be > 0'
    if (bar.accuracyM != null && (!Number.isFinite(bar.accuracyM) || bar.accuracyM <= 0)) {
      return 'accuracy must be > 0 (leave blank for equal weight)'
    }
    return null
  }

  const enabledBars = computed(() => bars.value.filter((b) => b.enabled !== false))

  function addBar({ a = null, b = null, knownDistance = null, unit = 'm', accuracy = null, name = null } = {}) {
    const id = crypto.randomUUID()
    const n = bars.value.length + 1
    bars.value.push({
      id,
      name: name?.trim() || `Bar ${n}`,
      a: a ? { kind: a.kind, id: a.id } : null,
      b: b ? { kind: b.kind, id: b.id } : null,
      knownDistanceM: toMetres(knownDistance, unit),
      // 1σ in metres, or null = "equal weight" (labelled as such in the report —
      // never presented as surveyed uncertainty).
      accuracyM: accuracy != null ? toMetres(accuracy, unit) : null,
      displayUnit: LENGTH_UNITS[unit] ? unit : 'm',
      enabled: true,
    })
    log(`Added scale bar ${bars.value[bars.value.length - 1].name}`, 'success', 'Scale', { channel: 'activity' })
    save()
    return id
  }

  // Patch one bar. Distances arrive in the bar's own display unit and are stored
  // in metres — there is exactly one conversion boundary and it is here.
  function updateBar(id, patch = {}) {
    const bar = bars.value.find((b) => b.id === id)
    if (!bar) return
    if ('name' in patch) bar.name = String(patch.name ?? '').trim() || bar.name
    if ('a' in patch) bar.a = patch.a ? { kind: patch.a.kind, id: patch.a.id } : null
    if ('b' in patch) bar.b = patch.b ? { kind: patch.b.kind, id: patch.b.id } : null
    if ('enabled' in patch) bar.enabled = patch.enabled !== false
    if ('displayUnit' in patch && LENGTH_UNITS[patch.displayUnit]) {
      // Changing the unit re-labels the same physical length; it must not move it.
      bar.displayUnit = patch.displayUnit
    }
    if ('knownDistance' in patch) {
      const v = Number(patch.knownDistance)
      bar.knownDistanceM = Number.isFinite(v) && v > 0 ? toMetres(v, bar.displayUnit) : null
    }
    if ('accuracy' in patch) {
      const raw = String(patch.accuracy ?? '').trim()
      const v = Number(raw)
      if (raw === '') bar.accuracyM = null
      else if (Number.isFinite(v) && v > 0) bar.accuracyM = toMetres(v, bar.displayUnit)
      else {
        log(`Scale bar "${bar.name}": accuracy must be greater than zero; leave it blank for equal weight`,
          'warn', 'Scale')
        return false
      }
    }
    save()
    return true
  }

  function setBarEnabled(id, enabled) {
    const bar = bars.value.find((b) => b.id === id)
    if (!bar || bar.enabled === enabled) return
    bar.enabled = enabled
    log(`Scale bar "${bar.name}" ${enabled ? 'enabled' : 'excluded from the fit'}`,
      'info', 'Scale', { channel: 'activity' })
    save()
  }

  function removeBar(id) {
    const idx = bars.value.findIndex((b) => b.id === id)
    if (idx < 0) return
    const [removed] = bars.value.splice(idx, 1)
    log(`Removed scale bar "${removed.name}"`, 'info', 'Scale', { channel: 'activity' })
    save()
  }

  // Bars referencing a point/image that no longer exists. Reported, never
  // auto-removed: a bar that silently disappears takes the user's measurement
  // with it, and the repair (re-point the endpoint) is theirs to make.
  function brokenBars(markerIds, imageIds) {
    const alive = ({ kind, id }) => (kind === 'camera' ? imageIds.has(id) : markerIds.has(id))
    return bars.value.filter((b) => (b.a && !alive(b.a)) || (b.b && !alive(b.b)))
  }

  // ── project-store contract ────────────────────────────────────────────────
  function normalizeStored(data) {
    if (!Array.isArray(data?.bars)) return []
    return data.bars
      .filter((b) => b && typeof b.id === 'string')
      .map((b) => ({
        id: b.id,
        name: b.name || 'Bar',
        a: b.a?.id ? { kind: b.a.kind === 'camera' ? 'camera' : 'marker', id: b.a.id } : null,
        b: b.b?.id ? { kind: b.b.kind === 'camera' ? 'camera' : 'marker', id: b.b.id } : null,
        knownDistanceM: Number.isFinite(b.knownDistanceM) && b.knownDistanceM > 0 ? b.knownDistanceM : null,
        accuracyM: Number.isFinite(b.accuracyM) && b.accuracyM > 0 ? b.accuracyM : null,
        displayUnit: LENGTH_UNITS[b.displayUnit] ? b.displayUnit : 'm',
        enabled: b.enabled !== false,
      }))
  }

  async function restore({ projectId }) {
    const generation = ++restoreGeneration
    const restored = normalizeStored(await opfs.loadScaleBars(projectId))
    if (generation !== restoreGeneration || projectId !== projects.currentProjectId) return
    bars.value = restored
    if (bars.value.length) {
      log(`Scale bars restored: ${bars.value.length}`, 'success', 'Scale')
    }
  }

  function clear({ purge = false } = {}) {
    restoreGeneration++
    bars.value = []
    if (purge && isPersisting()) opfs.deleteScaleBars(projects.currentProjectId).catch(() => {})
  }

  return {
    bars,
    enabledBars,
    validateBar,
    addBar,
    updateBar,
    setBarEnabled,
    removeBar,
    brokenBars,
    save,
    // project-store contract
    clear,
    restore,
  }
}))
