import { computed, watch } from 'vue'
import { fitSimilarity, applySimilarity } from '../../core/products/georef.js'
import { cameraCenter } from '../../core/sfm/geometry.js'
import { triangulateAllGcps } from '../../core/sfm/gcpTriangulation.js'
import { gcpGuidesForImage, gcpEstimateForImage } from '../../core/sfm/gcpGuides.js'
import { isGeographic } from '../../core/crs.js'
import { normalizedGroundResidual, precisionFromGcp } from '../../core/gcpAccuracy.js'
import { isGroundControl } from '../../core/io/gcp.js'

// One spelling of "may this point constrain the solve" (core/io/gcp.js), shared
// with the anchored-BA gate. Never re-derive it from finite coordinates alone.
const groundControl = (g) => isGroundControl(g, { precision: precisionFromGcp })

const finite3d = (p) => Number.isFinite(p?.x) && Number.isFinite(p?.y) && Number.isFinite(p?.z)
const inverseVariance3d = (p) => {
  const axes = [p?.accuracyX, p?.accuracyY, p?.accuracyZ]
  if (axes.every((v) => Number.isFinite(v) && v > 0)) {
    return 3 / axes.reduce((sum, sigma) => sum + sigma * sigma, 0)
  }
  const sigma = p?.accXYZ
  return Number.isFinite(sigma) && sigma > 0 ? 1 / (sigma * sigma) : 1
}

// Georeferencing (the SfM→CRS similarity fit) and the read-only accuracy reports
// built on it. Split out of useReconstructionStore: this is post-hoc *measurement*
// against an already-built model, not state management or worker orchestration.
//
// Two rules from METHODS.md that this file must not quietly break:
//
//  • GCPs beat poses. When ≥3 GCPs triangulate they define the fit; imported camera
//    poses are the fallback. GCPs are the accuracy-defining source.
//  • The reports are NOT robust, deliberately. `triangulateAllGcps` is called
//    without outlier rejection here, and `poseResidualReport` drops nothing —
//    discarding a bad mark or a drifting camera would hide exactly the
//    disagreement these reports exist to surface. (Guided marking in
//    core/sfm/gcpGuides.js is the opposite case and *does* want robust, because a
//    misclick must not drag the aiming guide in every other image.)
//
// Deps are getters/refs so the store keeps ownership of the state:
//   sparseCameras, images, georef, healthDirty — refs/computeds
//   poses(), gcps(), currentCrs() — snapshot getters over the other stores
//   persist(), log() — store side effects
export function createGeoreferencing({
  sparseCameras, images, georef, healthDirty, poses, gcps, currentCrs, persist, log,
  modelStamp = () => null,
}) {

  const evidenceKey = computed(() => {
    // Camera buffers are markRaw; healthDirty signals in-place model edits.
    void healthDirty.value
    return JSON.stringify({ crs: currentCrs(), model: modelStamp(),
      cameras: [...sparseCameras.value], images: images.value.map(im => [im.id, im.uuid]),
      gcps: gcps(), poses: poses() })
  })
  const validGeoref = computed(() => georef.value?.evidenceKey === evidenceKey.value ? georef.value : null)
  watch([evidenceKey, () => georef.value], () => {
    if (georef.value && !validGeoref.value) georef.value = null
  }, { flush: 'sync' })

  // 3D-3D correspondences for the SfM→CRS fit: registered sparse camera centres
  // ↔ imported camera poses (both keyed to images; poses are in the project CRS).
  function georefPairs() {
    const cams = sparseCameras.value
    if (!cams.size) return []
    const imgById = new Map(images.value.map((im) => [im.id, im]))
    const pairs = []
    for (const p of poses()) {
      if (p.enabled === false || p.imageId == null || !finite3d(p)) continue
      const im = imgById.get(p.imageId)
      if (!im) continue
      const cam = cams.get(im.uuid)
      if (!cam) continue
      pairs.push({ src: cameraCenter(cam), dst: [p.x, p.y, p.z], weight: inverseVariance3d(p) })
    }
    return pairs
  }

  // Maps needed to resolve a GCP observation's imageId → its registered camera:
  // imageId → image (for .uuid), and the sparse cloud's cameras (uuid-keyed).
  function imagesById() {
    return new Map(images.value.map((im) => [im.id, im]))
  }

  // Fit-eligible control points: enabled controls with ≥2 observations that resolve to a
  // *registered* camera — cheap sync check, no triangulation, used to gate
  // `canGeoreferenceGcps` and to decide whether it's worth triangulating at all.
  function qualifyingGcps() {
    const cams = sparseCameras.value
    if (!cams.size) return []
    const imgById = imagesById()
    return gcps().filter((g) => {
      if (!groundControl(g)) return false
      const nRegistered = (g.observations || []).filter((o) => {
        const uuid = imgById.get(o.imageId)?.uuid
        return uuid != null && cams.has(uuid)
      }).length
      return nRegistered >= 2
    })
  }

  // True when a GCP-based fit is *plausible* (≥3 GCPs each with ≥2 registered
  // observations) — cheap, does not triangulate.
  const canGeoreferenceGcps = computed(() => qualifyingGcps().length >= 3)

  // 3D-3D correspondences for the SfM→CRS fit from GCPs: triangulate each
  // qualifying GCP in the current SfM frame, pair with its surveyed position.
  async function gcpGeorefPairs() {
    const qualifying = qualifyingGcps()
    if (!qualifying.length) return []
    const results = await triangulateAllGcps(qualifying, sparseCameras.value, imagesById())
    return results
      .filter(({ tri }) => tri != null)
      .map(({ gcp, tri }) => ({
        src: [tri.x, tri.y, tri.z], dst: [gcp.x, gcp.y, gcp.z],
        weight: inverseVariance3d(gcp),
        precision: precisionFromGcp(gcp),
      }))
  }

  // True when a georeference can be fit (≥3 correspondences from GCPs or poses),
  // so the product modals can offer a real-CRS output alongside the local frame.
  const canGeoreference = computed(() => !isGeographic(currentCrs())
    && (canGeoreferenceGcps.value || georefPairs().length >= 3))

  // Fit (or refit) the SfM→CRS similarity, targeting the current project CRS.
  // GCPs are the accuracy-defining source and win when ≥3 triangulate; imported
  // camera poses are the fallback. Returns the georef record or null.
  async function georeference() {
    const clearFit = () => {
      if (georef.value) {
        georef.value = null
        healthDirty.value++
        persist()
      }
    }
    if (isGeographic(currentCrs())) {
      clearFit()
      log(`Georeference: ${currentCrs()} uses angular coordinates; choose a projected metric CRS`,
        'warn', 'Products')
      return null
    }
    const evidenceAtStart = evidenceKey.value
    const gcpPairs = await gcpGeorefPairs()
    if (evidenceKey.value !== evidenceAtStart) return null
    const usingGcps = gcpPairs.length >= 3
    if (usingGcps) {
      const datums = new Set(qualifyingGcps().map((g) => g.verticalDatum ?? 'unknown'))
      if (datums.size > 1 || datums.has('unknown')) {
        log(`Georeference: GCP height datum is ${[...datums].join(' / ')} — verify ellipsoidal and orthometric heights are not mixed`,
          'warn', 'Products')
      }
    }
    const pairs = usingGcps ? gcpPairs : georefPairs()
    if (pairs.length < 3) {
      clearFit()
      log('Georeference: need ≥3 GCPs or camera poses matching registered images', 'warn', 'Products')
      return null
    }
    if (usingGcps) {
      const xs = pairs.map((p) => p.dst[0]), ys = pairs.map((p) => p.dst[1]), zs = pairs.map((p) => p.dst[2])
      const horizontalSpan = Math.hypot(Math.max(...xs)-Math.min(...xs), Math.max(...ys)-Math.min(...ys))
      const verticalSpan = Math.max(...zs)-Math.min(...zs)
      const verticalSigma = Math.max(...qualifyingGcps().map((g) => g.accuracyZ ?? 0))
      if (horizontalSpan > 0 && verticalSpan < 3 * verticalSigma) {
        log(`Georeference: GCP vertical range (${verticalSpan.toPrecision(3)}) is small relative to vertical uncertainty; scale/tilt may be weakly constrained`,
          'warn', 'Products')
      }
    }
    const fit = fitSimilarity(pairs)
    if (!fit) {
      clearFit()
      log('Georeference: fit failed (degenerate configuration)', 'warn', 'Products')
      return null
    }
    georef.value = {
      evidenceKey: evidenceAtStart,
      sim: { scale: fit.scale, R: fit.R, t: fit.t },
      crs: currentCrs(), rms: fit.rms, count: fit.count, method: usingGcps ? 'gcps' : 'poses',
    }
    log(`Georeference: ${fit.count} ${usingGcps ? 'GCPs' : 'poses'} → ${currentCrs()}, `
      + `scale ${fit.scale.toPrecision(4)}, RMS ${fit.rms.toPrecision(3)}`, 'success', 'Products')
    healthDirty.value++   // GCP prune / refit → the hub overview must recompute
    persist()
    return georef.value
  }

  // Per-image pose residuals against the current georeference (Evaluate ▸ Pose
  // Residuals): apply the fitted similarity to each registered camera centre and
  // diff against the imported pose. Mirrors gcpAccuracyReport's shape and its
  // no-robust stance — dropping a camera from the diff would hide the drift this
  // report exists to surface. Returns [{ uuid, name, dx, dy, dz, dTotal }].
  function poseResidualReport() {
    const sim = validGeoref.value?.sim
    const cams = sparseCameras.value
    if (!sim || !cams.size) return []
    const imgById = new Map(images.value.map((im) => [im.id, im]))
    const out = []
    for (const p of poses()) {
      if (p.enabled === false || p.imageId == null || !finite3d(p)) continue
      const im = imgById.get(p.imageId)
      const cam = im && cams.get(im.uuid)
      if (!cam) continue
      const fit = applySimilarity(sim, cameraCenter(cam))
      const dx = fit[0] - p.x, dy = fit[1] - p.y, dz = fit[2] - p.z
      out.push({ uuid: im.uuid, name: im.name, source: p.source ?? 'imported',
        accuracyX: p.accuracyX ?? p.accXYZ, accuracyY: p.accuracyY ?? p.accXYZ,
        accuracyZ: p.accuracyZ ?? p.accXYZ, verticalDatum: p.verticalDatum ?? null,
        dx, dy, dz, dTotal: Math.hypot(dx, dy, dz) })
    }
    return out
  }

  // Per-point accuracy report against the current georeference: triangulate every
  // enabled control/check point, apply the control/pose-fitted similarity, and diff
  // against its surveyed CRS position. Checkpoints are deliberately present here
  // despite being absent from qualifyingGcps()/gcpGeorefPairs(): that is what makes
  // their residual independent of the adjustment.
  // position — plus the per-observation reprojection residual already computed
  // by triangulateGcp. Pure read against already-fitted state; cheap to recompute
  // on demand (e.g. every time the GCP table is shown or a mark is placed).
  // Returns [{ gcpId, name, viewCount, dx, dy, dz, dTotal, observations }] —
  // entries for untriangulable GCPs still appear with residuals `null`.
  async function gcpAccuracyReport() {
    const sim = validGeoref.value?.sim
    const enabled = gcps().filter((g) => g.enabled !== false)
    if (!enabled.length) return []
    const results = await triangulateAllGcps(enabled, sparseCameras.value, imagesById())
    const rows = results.map(({ gcp, tri }) => {
      if (!tri) {
        return { gcpId: gcp.id, name: gcp.name, role: gcp.role ?? 'control', viewCount: 0,
          sfm: null, dx: null, dy: null, dz: null, dTotal: null, observations: [] }
      }
      let dx = null, dy = null, dz = null, dTotal = null
      let normalized = null, normalizedAxes = null, chi2 = null
      if (sim && finite3d(gcp)) {
        const p = applySimilarity(sim, [tri.x, tri.y, tri.z])
        dx = p[0] - gcp.x; dy = p[1] - gcp.y; dz = p[2] - gcp.z
        dTotal = Math.hypot(dx, dy, dz)
        const nr = normalizedGroundResidual(gcp, [dx, dy, dz])
        normalized = nr?.normalized ?? null
        normalizedAxes = nr?.axes ?? null
        chi2 = nr?.chi2 ?? null
      }
      return {
        gcpId: gcp.id, name: gcp.name, role: gcp.role ?? 'control', viewCount: tri.viewCount,
        // Where the model puts the point, in SfM-frame units. For a control/check
        // point this is intermediate; for a MARKER it is the whole answer — a
        // marker has no surveyed coordinate to diff against, so its triangulated
        // position and the per-view reprojection errors are the only quality
        // signals it has. It is also what the scale-bar fit measures across.
        sfm: { x: tri.x, y: tri.y, z: tri.z },
        dx, dy, dz, dTotal, normalized, normalizedAxes, chi2,
        observations: tri.perViewReprojPx,
      }
    })
    // When no checkpoints exist, leave-one-control-out prediction is the next
    // best validation: fit without one control and predict that withheld point.
    const controls = results.filter(({ gcp, tri }) => tri && groundControl(gcp))
    if (controls.length >= 4) {
      for (const withheld of controls) {
        const fit = fitSimilarity(controls.filter((r) => r !== withheld).map(({ gcp, tri }) => ({
          src: [tri.x, tri.y, tri.z], dst: [gcp.x, gcp.y, gcp.z],
          weight: inverseVariance3d(gcp), precision: precisionFromGcp(gcp),
        })))
        if (!fit) continue
        const predicted = applySimilarity(fit, [withheld.tri.x, withheld.tri.y, withheld.tri.z])
        const residual = predicted.map((v, i) => v - [withheld.gcp.x, withheld.gcp.y, withheld.gcp.z][i])
        const nr = normalizedGroundResidual(withheld.gcp, residual)
        const row = rows.find((r) => r.gcpId === withheld.gcp.id)
        if (row) {
          row.looDx = residual[0]; row.looDy = residual[1]; row.looDz = residual[2]
          row.looTotal = Math.hypot(...residual); row.looNormalized = nr?.normalized ?? null
          row.looNormalizedAxes = nr?.axes ?? null
        }
      }
    }
    return rows
  }

  // Guided marking: for every enabled GCP not yet marked on `imageId`, where the
  // current cloud's poses say it must lie in that image — a predicted pixel
  // (≥2 other observations) or an epipolar line (exactly 1). Empty when the
  // image isn't registered. Cheap read against already-fitted state, recomputed
  // on demand like gcpAccuracyReport.
  //
  // Deliberately silent. This runs on every tab switch, selection change and
  // re-render, so logging here reports the app's own recomputation rather than
  // anything the user did — it buried the console in lines that repeated whatever
  // was already on screen. The one moment worth a line is when a mark is *placed*;
  // App.vue's `logGcpMark` does that, comparing the click against this guide.
  async function gcpGuides(imageId) {
    if (imageId == null || !gcps().length) return []
    return gcpGuidesForImage(gcps(), imageId, sparseCameras.value, imagesById())
  }

  // Where the model thinks `gcpId` is, projected into `imageId`, from *all* its
  // marks including that image's own. NOT a guide (see gcpEstimateForImage) — it's
  // for bracketing a mark to measure how far the new mark moved the estimate.
  async function gcpEstimate(gcpId, imageId) {
    const gcp = gcps().find((g) => g.id === gcpId)
    if (!gcp || imageId == null) return null
    const byId = imagesById()
    const targetCam = sparseCameras.value.get(byId.get(imageId)?.uuid)
    if (!targetCam) return null
    const camerasByImageId = new Map()
    for (const o of gcp.observations || []) {
      const cam = sparseCameras.value.get(byId.get(o.imageId)?.uuid)
      if (cam) camerasByImageId.set(o.imageId, cam)
    }
    return gcpEstimateForImage(gcp.observations, targetCam, camerasByImageId)
  }

  return { validGeoref, evidenceKey,
    georefPairs, imagesById, qualifyingGcps, canGeoreferenceGcps, gcpGeorefPairs,
    canGeoreference, georeference, poseResidualReport, gcpAccuracyReport,
    gcpGuides, gcpEstimate,
  }
}
