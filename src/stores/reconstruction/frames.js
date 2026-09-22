import { computed } from 'vue'
import { metresPerCrsUnit, linearCrsUnit } from '../../core/crs.js'

export function createFrameResolver({ mainSparseCloud, validGeoref, currentCrs, georeference, scaleFit, scaleFitStatus, log }) {
  // ── THE unit resolver (D2) ───────────────────────────────────────────────────
  // One place decides what frame a product is built in and what a length in it
  // MEANS. Evidence rank is `CRS georeference > scale constraints > none`, and
  // every product builder, every readout, every report and every export asks
  // here — a scalar-only getter would not be enough, because horizontal distance
  // and Δz also need the resolved orientation.
  //
  //   opts.crs — 'local' (never georeference), a truthy CRS request (fit/refit on
  //              demand), or absent (use an already-fitted georeference if it
  //              matches the current CRS, but never fit one as a side effect).
  //
  // Returns { frameSpec, unit:'m'|'model', scale, source:'georef'|'scalebars'|null,
  //           crs, stamp } where `stamp` identifies the sparse model the frame was
  //   resolved against, so a product can record what it was built in (D8/D11).
  //
  // A scale-bar project is METRIC WITH NO CRS — a combination that did not exist
  // before this. Export paths must not attach the project CRS merely because the
  // coordinates are metric.
  function georefUnits(crs) {
    const metresPerUnit = metresPerCrsUnit(crs)
    if (!(metresPerUnit > 0)) throw new Error('The project CRS has no known linear unit')
    const unit = linearCrsUnit(crs)
    return { unit, metresPerUnit }
  }
  const metricScale = g => g.sim.scale * georefUnits(g.crs).metresPerUnit

  async function effectiveFrameSpec(opts = {}) {
    const stamp = (() => {
      const c = mainSparseCloud.value
      return c ? { id: c.id, createdAt: c.createdAt ?? null } : null
    })()
    const wantsCrs = opts.crs !== undefined && opts.crs && opts.crs !== 'local'
    const wantsLocal = opts.crs === 'local'

    // 1. A CRS georeference outranks scale bars: it already carries a scale, and
    //    two parallel unit systems is the failure mode to avoid. With bars also
    //    present they become checks (their residuals are still reported).
    let g = null
    if (wantsCrs) {
      g = validGeoref.value?.crs === currentCrs() ? validGeoref.value : await georeference()
    } else if (opts.crs === undefined && validGeoref.value?.crs === currentCrs()) {
      g = validGeoref.value
    }
    if (g) {
      return {
        frameSpec: { kind: 'similarity', ...g.sim, crs: g.crs, ...georefUnits(g.crs) },
        unit: georefUnits(g.crs).unit, scale: metricScale(g), source: 'georef', crs: g.crs, stamp,
      }
    }

    // An explicit LOCAL request changes orientation/translation, not the unit
    // evidence rank. When a georeference exists, use its scalar to make the local
    // frame metric while deliberately omitting its CRS placement. Otherwise a
    // project with both GCPs and bars would let the lower-ranked bars define local
    // products even though they are checks everywhere else.
    const existingGeoref = validGeoref.value?.crs === currentCrs() ? validGeoref.value : null
    if (wantsLocal && existingGeoref) {
      return {
        frameSpec: { kind: 'scaled-local', scale: metricScale(existingGeoref) },
        unit: 'm', scale: metricScale(existingGeoref), source: 'georef', crs: 'local', stamp,
      }
    }

    // 2. Scale constraints. Refused when the fit no longer describes the current
    //    model or measurements — stale metres are worse than honest model units.
    const status = scaleFitStatus()
    if (status.valid) {
      return {
        frameSpec: { kind: 'scaled-local', scale: scaleFit.value.scale },
        unit: 'm', scale: scaleFit.value.scale, source: 'scalebars', crs: 'local', stamp,
      }
    }
    if (scaleFit.value && status.reason !== 'none') {
      log(`Scale: the fitted scale no longer matches the project (${status.reason}) — `
        + 'apply the scale bars again to restore metres', 'warn', 'Scale')
    }

    // 3. Nothing. Up-to-scale model units — and every readout must SAY so rather
    //    than printing a bare number (D9).
    return { frameSpec: { kind: 'local' }, unit: 'model', scale: 1, source: null, crs: 'local', stamp }
  }

  // A SYNC signature of what currently defines the unit — `{ source, scale, crs }`.
  // The resolver is async because it may fit a georeference on demand; a stored
  // product only needs to be *compared* against the current answer, and a render
  // must never trigger a fit. Fitting is what `effectiveFrameSpec` is for.
  const currentFrameSignature = computed(() => {
    const g = validGeoref.value?.crs === currentCrs() ? validGeoref.value : null
    if (g) {
      const frameSpec = { kind: 'similarity', ...g.sim, crs: g.crs, ...georefUnits(g.crs) }
      return { source: 'georef', scale: metricScale(g), crs: g.crs,
        frameKey: JSON.stringify(frameSpec) }
    }
    if (scaleFitStatus().valid) {
      const frameSpec = { kind: 'scaled-local', scale: scaleFit.value.scale }
      return { source: 'scalebars', scale: scaleFit.value.scale, crs: 'local',
        frameKey: JSON.stringify(frameSpec) }
    }
    return { source: null, scale: 1, crs: 'local', frameKey: JSON.stringify({ kind: 'local' }) }
  })

  // Is a persisted product still expressed in the frame the project now uses?
  // A refit does NOT invalidate the raster — its coordinates are still exactly what
  // they were, in the frame it records — but it does mean the numbers on it are no
  // longer this project's metres, so it must not be mistaken for a current product.
  // Returns { stale:boolean, reason:string|null }. An older product with no recorded
  // stamp is 'unknown', not silently 'current'.
  function productFrameStatus(product) {
    if (!product) return { stale: false, reason: null }
    const stamp = product.frameStamp
    if (!stamp) return { stale: false, reason: 'unknown' }
    const cloud = mainSparseCloud.value
    if (stamp.cloudId && (!cloud || stamp.cloudId !== cloud.id
        || stamp.cloudCreatedAt !== (cloud.createdAt ?? null))) {
      return { stale: true, reason: 'the sparse model changed' }
    }

    // A deliberately local/model-unit product remains valid when a georeference
    // is later fitted. It records its own coordinate system; evidence rank chooses
    // defaults for new work, it does not retroactively reinterpret old rasters.
    if (stamp.source == null) return { stale: false, reason: null }

    let now
    if (stamp.source === 'georef') {
      const g = validGeoref.value?.crs === currentCrs() ? validGeoref.value : null
      if (!g) return { stale: true, reason: 'the georeference is no longer available' }
      // A georeference can produce full project-CRS coordinates or a metric local
      // frame using only its scalar. Compare the refit in the mode this product
      // actually recorded, rather than against whichever mode is the global default.
      let recordedKind = null
      try { recordedKind = stamp.frameKey ? JSON.parse(stamp.frameKey)?.kind : null } catch {}
      const frameSpec = recordedKind === 'scaled-local'
        ? { kind: 'scaled-local', scale: metricScale(g) }
        : { kind: 'similarity', ...g.sim, crs: g.crs, ...georefUnits(g.crs) }
      now = {
        source: 'georef', scale: metricScale(g),
        crs: recordedKind === 'scaled-local' ? 'local' : g.crs,
        frameKey: JSON.stringify(frameSpec),
      }
    } else {
      now = currentFrameSignature.value
    }
    if (stamp.source !== now.source) return { stale: true, reason: 'the scale source changed' }
    if (stamp.frameKey && stamp.frameKey !== now.frameKey) {
      return { stale: true, reason: stamp.source === 'georef'
        ? 'the georeference was refitted' : 'the scale was refitted' }
    }
    // Compatibility for the first stamped products, before `frameKey` recorded
    // the full georeference rotation/translation as well as its scalar.
    if (!stamp.frameKey && Math.abs(stamp.scale - now.scale) > 1e-12 * Math.max(1, Math.abs(now.scale))) {
      return { stale: true, reason: 'the scale was refitted' }
    }
    if (stamp.crs !== now.crs) return { stale: true, reason: 'the CRS changed' }
    return { stale: false, reason: null }
  }

  // What a product should record about the frame it was built in (D8/D11).
  const frameStampOf = (resolved) => ({
    source: resolved.source, scale: resolved.scale, crs: resolved.crs, unit: resolved.unit,
    frameKey: JSON.stringify(resolved.frameSpec),
    cloudId: resolved.stamp?.id ?? null, cloudCreatedAt: resolved.stamp?.createdAt ?? null,
    at: new Date().toISOString(),
  })

  return { effectiveFrameSpec, currentFrameSignature, productFrameStatus, frameStampOf }
}
