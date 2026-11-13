// The reconstruction store's frame state that is not a fit: the REGION box
// (Tools ▸ Model ▾ ▸ Region, core/products/region.js) and the user ORIENTATION of
// the local frame (Tools ▸ Model ▾ ▸ Orient model, core/products/orientation.js),
// both stamped with the main sparse model and carried over by a model edit.
//
// Moved verbatim from the store: what it shares comes in by name; names the store
// defines further down come in late (late.js).

import { ref, computed } from 'vue'
import { normalizeRegion, regionStatus, regionMask } from '../../core/products/region.js'
import { selectPoints } from '../../core/products/cloudEdit.js'
import { normalizeOrientation, orientationStatus, orientationBasis } from '../../core/products/orientation.js'

export function createFrameState({ log, mainSparseCloud, save, validGeoref }) {
  // The reconstruction REGION (Tools ▸ Model ▾ ▸ Region, core/products/region.js):
  // a model-frame box that bounds depth maps, fusion, mesh and DEM input. Stamped
  // with the main sparse model; a stale region is ignored, never reinterpreted.
  // Persisted in reconstruction.json; absent ⇒ none. Not cleared by a rebuild —
  // the stamp makes it stale, so the user can see it and refit it.
  const region = ref(null)
  const regionState = computed(() => regionStatus(region.value, mainSparseCloud.value))
  // The box to apply to a run right now, or null (none / stale / invalid).
  function activeRegion() {
    return regionState.value.active ? normalizeRegion(region.value) : null
  }
  function setRegion({ min, max }) {
    const c = mainSparseCloud.value
    const next = normalizeRegion({ min, max, sourceStamp: c ? { id: c.id, createdAt: c.createdAt ?? null } : null })
    if (!next || !c) return false
    region.value = next
    const f = (v) => v.map((x) => x.toPrecision(5)).join(', ')
    log(`Region set: [${f(next.min)}] – [${f(next.max)}]`, 'info', 'Reconstruction', { channel: 'activity' })
    save()
    return true
  }
  // A copy of a flat cloud ({ count, pos, col?, nrm? }) cut to the active region,
  // or null when no region applies — the region is model-frame data, so an
  // imported cloud (its own frame) is never cut. Logs what it removed.
  function clipToRegion(cloud, label) {
    const r = activeRegion()
    if (!r || cloud.imported) return null
    const { keep, kept } = regionMask(cloud.pos, cloud.count, r)
    log(`${label}: region keeps ${kept.toLocaleString()} of ${cloud.count.toLocaleString()} points`, 'info', 'Products')
    return selectPoints(cloud, keep, kept)
  }
  // Settings for a dense run with the active region attached (null ⇒ unbounded).
  function withRegion(settings) {
    const r = activeRegion()
    if (r) log('Dense: limited to the region', 'info', 'Dense')
    else if (regionState.value.reason === 'stale')
      log('Dense: the region was drawn on an older model and is ignored — refit it to use it', 'warn', 'Dense')
    return { ...settings, region: r ? { min: r.min, max: r.max } : null }
  }
  // The user ORIENTATION of the local frame (Tools ▸ Model ▾ ▸ Orient model,
  // core/products/orientation.js). Like scale, it lives in the frame, never in the
  // coordinates; the frame resolver applies it to local/scale-bar products, and a
  // georeference outranks it. Same stamp rule as the region.
  const orientation = ref(null)
  const orientationState = computed(() => orientationStatus(orientation.value, mainSparseCloud.value))
  function activeOrientationBasis() {
    return orientationState.value.active ? orientationBasis(orientation.value) : null
  }
  function setOrientation({ up, origin, headingDeg = 0 }) {
    const c = mainSparseCloud.value
    const next = normalizeOrientation({
      up,
      origin,
      headingDeg,
      sourceStamp: c ? { id: c.id, createdAt: c.createdAt ?? null } : null,
    })
    if (!next || !c) return false
    orientation.value = next
    const f = (v) => v.map((x) => x.toPrecision(4)).join(', ')
    log(
      `Orientation set: up [${f(next.up)}], origin [${f(next.origin)}], heading ${next.headingDeg}°` +
        (validGeoref.value ? ' — the georeference outranks it for georeferenced products' : ''),
      'info',
      'Reconstruction',
      { channel: 'activity' },
    )
    save()
    return true
  }
  // An edit of the model (Optimize cameras, Gradual selection) keeps its frame: the
  // region and orientation drawn on it carry over to the edited model, rather than
  // going stale as they do on a rebuild. → the names of what carried over
  function carryFrameStamps(before, after) {
    const was = (s) => s && s.id === before.id && (s.createdAt ?? null) === (before.createdAt ?? null)
    const now = { id: after.id, createdAt: after.createdAt ?? null }
    const carried = []
    if (was(region.value?.sourceStamp)) {
      region.value = { ...region.value, sourceStamp: now }
      carried.push('region')
    }
    if (was(orientation.value?.sourceStamp)) {
      orientation.value = { ...orientation.value, sourceStamp: now }
      carried.push('orientation')
    }
    return carried
  }
  function clearOrientation() {
    if (!orientation.value) return
    orientation.value = null
    log('Orientation removed — the local frame is levelled from the cameras again', 'info', 'Reconstruction', {
      channel: 'activity',
    })
    save()
  }
  function clearRegion() {
    if (!region.value) return
    region.value = null
    log('Region cleared', 'info', 'Reconstruction', { channel: 'activity' })
    save()
  }

  return {
    region,
    regionState,
    activeRegion,
    setRegion,
    clipToRegion,
    withRegion,
    orientation,
    orientationState,
    activeOrientationBasis,
    setOrientation,
    carryFrameStamps,
    clearOrientation,
    clearRegion,
  }
}
