import { computed } from 'vue'
import { fitScale, weightFromAccuracy, scaleEvidenceDigest } from '../../core/products/scale.js'
import { cameraCenter } from '../../core/sfm/geometry.js'
import { triangulateGcp } from '../../core/sfm/gcpTriangulation.js'

// Scale constraints — the SfM→metres scalar fitted from known distances, and the
// read-only residual report built on it. Split out of useReconstructionStore for
// the same reason as georeferencing.js: this is post-hoc *measurement* against an
// already-built model, not state management or worker orchestration.
//
// Three rules this file must not quietly break:
//
//  • The georeference wins. A CRS similarity already carries a scale, so when
//    both exist the bars become CHECKS, not the definition (D2/D6). The one
//    resolver that decides is `effectiveFrameSpec` in the store; this file only
//    supplies the fit and the residuals.
//  • Every bar always reports a residual, whether or not it defined the scale,
//    and nothing is ever dropped from the report — only from the fit, and only
//    when the user unchecks it. Same stance as gcpAccuracyReport: a disagreeing
//    bar is exactly the disagreement the report exists to surface.
//  • The fit is a CACHE. It is derived from the sparse model, the enabled bar
//    records and the marks of the markers they reference, so it carries a source
//    stamp and an evidence digest and is refused when either moves (D11). Metres
//    on screen from a fit whose evidence has changed is worse than model units.
//
// Deps are getters/refs so the store keeps ownership of the state:
//   sparseCameras, images, mainSparseCloud, scaleFit, healthDirty — refs/computeds
//   bars(), gcps() — snapshot getters over the other stores
//   persist(), log() — store side effects
export function createScaling({
  sparseCameras, images, mainSparseCloud, scaleFit, healthDirty, bars, gcps, persist, log,
}) {
  const imagesById = () => new Map(images.value.map((im) => [im.id, im]))

  // The model half of the staleness stamp. `createdAt` is the part that actually
  // detects a re-run: upsertSparseCloud carries the cloud's `id` forward on a
  // rebuild but refreshes `createdAt` (the same reasoning as the depth-map index).
  function sourceStamp() {
    const c = mainSparseCloud.value
    return c ? { id: c.id, createdAt: c.createdAt ?? null } : null
  }

  // The evidence half: the enabled bars plus the observations of every marker they
  // reference. Camera endpoints need nothing here — a camera centre comes from the
  // model, which the source stamp already covers.
  function evidenceDigest() {
    const referenced = new Set()
    for (const b of bars()) {
      if (b.enabled === false) continue
      for (const e of [b.a, b.b]) if (e?.kind === 'marker') referenced.add(e.id)
    }
    const markers = gcps()
      .filter((g) => referenced.has(g.id))
      .map((g) => ({ id: g.id, role: g.role, enabled: g.enabled,
        observations: g.observations ?? [] }))
    return scaleEvidenceDigest(bars(), markers)
  }

  // Resolve one endpoint to a position in the SfM world frame, or null with a
  // reason. Both kinds land in the same frame, so a bar's model distance is the
  // plain Euclidean norm between them.
  async function endpointPosition(endpoint) {
    if (!endpoint?.id) return { pos: null, reason: 'no endpoint' }
    const cams = sparseCameras.value
    if (endpoint.kind === 'camera') {
      const im = images.value.find((i) => i.id === endpoint.id)
      if (!im) return { pos: null, reason: 'image removed' }
      const cam = cams.get(im.uuid)
      if (!cam) return { pos: null, reason: `${im.name} is not registered` }
      return { pos: cameraCenter(cam), reason: null }
    }
    const g = gcps().find((p) => p.id === endpoint.id)
    if (!g) return { pos: null, reason: 'marker removed' }
    if (g.role !== 'marker') return { pos: null, reason: `${g.name} is no longer a marker` }
    if (g.enabled === false) return { pos: null, reason: `${g.name} is disabled` }
    const camerasByImageId = new Map()
    const byId = imagesById()
    for (const o of g.observations ?? []) {
      const cam = cams.get(byId.get(o.imageId)?.uuid)
      if (cam) camerasByImageId.set(o.imageId, cam)
    }
    if (camerasByImageId.size < 2) {
      return { pos: null, reason: `${g.name} needs ≥2 marks in registered images` }
    }
    // NOT robust, deliberately: this is the measurement itself, and a mark that
    // disagrees is the disagreement the residual exists to report. (Guided
    // marking is the opposite case and does want robust — see gcpGuides.js.)
    const tri = await triangulateGcp(g.observations, camerasByImageId)
    if (!tri) return { pos: null, reason: `${g.name} did not triangulate` }
    return { pos: [tri.x, tri.y, tri.z], reason: null, viewCount: tri.viewCount }
  }

  // Model-frame length of every bar, with the reason when it has none. One pass,
  // shared by the fit and the report so the two can never disagree.
  async function measureBars() {
    const validate = (b) => {
      if (!b?.a?.id || !b?.b?.id) return 'endpoint missing'
      if (b.a.kind === b.b.kind && b.a.id === b.b.id) return 'both endpoints are the same point'
      if (!Number.isFinite(b.knownDistanceM) || b.knownDistanceM <= 0) return 'distance must be > 0'
      return null
    }
    const out = []
    for (const bar of bars()) {
      const invalid = validate(bar)
      if (invalid) { out.push({ bar, modelDistance: null, reason: invalid }); continue }
      const a = await endpointPosition(bar.a)
      const b = await endpointPosition(bar.b)
      if (!a.pos || !b.pos) {
        out.push({ bar, modelDistance: null, reason: a.reason ?? b.reason })
        continue
      }
      const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2])
      if (!(d > 0)) {
        out.push({ bar, modelDistance: null, reason: 'endpoints coincide in the model' })
        continue
      }
      out.push({ bar, modelDistance: d, reason: null })
    }
    return out
  }

  // True when a scale could be fitted at all — cheap, does not triangulate.
  const canFitScale = computed(() => sparseCameras.value.size > 0
    && bars().some((b) => b.enabled !== false && b.a?.id && b.b?.id
      && Number.isFinite(b.knownDistanceM) && b.knownDistanceM > 0))

  // Is the cached fit still describing the current evidence? A fit whose model or
  // measurements have moved is refused rather than shown — see D11. An older fit
  // with no stamp at all counts as stale for exactly the same reason.
  function scaleFitStatus() {
    const fit = scaleFit.value
    if (!fit) return { valid: false, reason: 'none' }
    const stamp = sourceStamp()
    if (!fit.sourceStamp || !stamp) return { valid: false, reason: 'unstamped' }
    if (fit.sourceStamp.id !== stamp.id || fit.sourceStamp.createdAt !== stamp.createdAt) {
      return { valid: false, reason: 'model rebuilt' }
    }
    if (fit.evidenceDigest !== evidenceDigest()) return { valid: false, reason: 'measurements changed' }
    return { valid: true, reason: null }
  }

  // Fit (or refit) the SfM→metres scale from the enabled scale bars. Returns the
  // scaleFit record or null. Logs the fit WITH its inputs — a derived number
  // whose inputs are not in the log is not reproducible.
  async function fitScaleBars() {
    const clearFit = () => {
      if (scaleFit.value) { scaleFit.value = null; healthDirty.value++; persist() }
    }
    if (!sparseCameras.value.size) {
      log('Scale: build the sparse model first', 'warn', 'Scale')
      return null
    }
    const measured = await measureBars()
    const usable = measured.filter((m) => m.bar.enabled !== false && m.modelDistance != null)
    for (const m of measured) {
      if (m.bar.enabled !== false && m.reason) {
        log(`Scale: bar "${m.bar.name}" cannot be measured — ${m.reason}`, 'warn', 'Scale')
      }
    }
    if (!usable.length) {
      clearFit()
      log('Scale: no usable scale bar (need one with two resolvable endpoints and a positive distance)',
        'warn', 'Scale')
      return null
    }
    const fit = fitScale(usable.map(({ bar, modelDistance }) => ({
      id: bar.id,
      modelDistance,
      knownDistance: bar.knownDistanceM,
      accuracy: bar.accuracyM,
      weight: weightFromAccuracy(bar.accuracyM),
    })))
    if (!fit) {
      clearFit()
      log('Scale: fit failed (degenerate input)', 'warn', 'Scale')
      return null
    }
    const byId = new Map(usable.map((m) => [m.bar.id, m.bar]))
    scaleFit.value = {
      scale: fit.scale,
      rms: fit.rms,
      count: fit.count,
      method: 'scalebars',
      sourceStamp: sourceStamp(),
      evidenceDigest: evidenceDigest(),
      createdAt: new Date().toISOString(),
      constraints: fit.constraints.map((c) => ({
        id: c.id,
        name: byId.get(c.id)?.name ?? null,
        modelDistance: c.modelDistance,
        knownDistanceM: c.knownDistance,
        accuracyM: c.accuracy,
        residualM: c.residual,
        normalizedResidual: c.normalizedResidual,
      })),
    }
    const weighted = usable.some((m) => m.bar.accuracyM != null)
    log(`Scale: ${fit.count} bar(s) → ${fit.scale.toPrecision(6)} m per model unit, `
      + `RMS ${fit.rms.toPrecision(3)} m (${weighted ? 'inverse-variance weighted' : 'equal weight'}); `
      + usable.map(({ bar, modelDistance }) =>
        `"${bar.name}" ${modelDistance.toPrecision(6)} u = ${bar.knownDistanceM} m`
        + (bar.accuracyM != null ? ` ±${bar.accuracyM}` : '')).join(', '),
    'success', 'Scale')
    healthDirty.value++
    persist()
    return scaleFit.value
  }

  // Per-bar residuals against whatever currently defines the scale. `scale` is
  // supplied by the caller (the store's effectiveFrameSpec resolver) so a
  // georeferenced project reports its bars as CHECKS against the CRS fit rather
  // than against a scale they did not define.
  //
  // Every bar appears, including disabled and unmeasurable ones — a bar that
  // vanishes from the report takes the user's measurement with it. Returns
  // [{ id, name, enabled, modelDistance, knownDistanceM, accuracyM, measuredM,
  //    residualM, normalizedResidual, weighting, reason }].
  async function scaleBarReport(scale = null) {
    const measured = await measureBars()
    return measured.map(({ bar, modelDistance, reason }) => {
      const measuredM = modelDistance != null && Number.isFinite(scale) && scale > 0
        ? modelDistance * scale : null
      const residualM = measuredM != null && Number.isFinite(bar.knownDistanceM)
        ? measuredM - bar.knownDistanceM : null
      return {
        id: bar.id,
        name: bar.name,
        enabled: bar.enabled !== false,
        endpoints: [bar.a, bar.b],
        modelDistance,
        knownDistanceM: bar.knownDistanceM,
        accuracyM: bar.accuracyM,
        displayUnit: bar.displayUnit ?? 'm',
        measuredM,
        residualM,
        normalizedResidual: residualM != null && bar.accuracyM > 0 ? residualM / bar.accuracyM : null,
        // Named, not implied: a bar with no declared σ is equally weighted, and
        // must never be presented as if it carried surveyed uncertainty.
        weighting: bar.accuracyM != null ? 'inverse-variance' : 'equal weight',
        reason,
      }
    })
  }

  return { canFitScale, fitScaleBars, scaleBarReport, scaleFitStatus, measureBars }
}
