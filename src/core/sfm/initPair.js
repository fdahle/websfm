import { fundamentalToEssential, recoverPose, triangulateDlt } from './reconstruction.js'
import { I3, essentialSingularValues } from './rotations.js'
import { toNorm, camToP34flat } from './tracks.js'
import { projectPoint, medianTriangulationAngle } from './geometry.js'

// Initial-pair selection, lifted verbatim out of reconstruct(). A two-view seed
// is the single best predictor of how well the model grows, so we probe every
// candidate (pose recovery + triangulation + cheirality + init reprojection) and
// pick the geometrically cleanest one over the parallax floor rather than the
// highest inlier count. Pure: the reconstruct-local helpers it needs
// (`imageByUuid`, `numStats`, `projDepth`) are injected so there's no shared
// module state and no import cycle back into sfm.js.
//
// Returns a discriminated result the orchestrator consumes:
//   { status: 'idle' }                              — no candidate pairs at all
//   { status: 'error' }                             — pose recovery failed for all
//   { status: 'ok', best, perPairInitReproj }       — commit `best` to the model
// where `best` carries { entry, iA, iB, cA, cB, points, angle, esv, inliers, … }.
export async function selectInitPair(
  { donePairs, Kmap, settings, imageByUuid, numStats, projDepth },
  { onLog, onProgress } = {},
) {
  const log = onLog ?? (() => {})

  // Reprojection stats for one *candidate* two-view init (its own cA/cB + points),
  // before it is committed to the model. Lets us compare seeds and pick the
  // geometrically cleanest one rather than the first that clears the parallax floor.
  function initReprojStats(init) {
    const residuals = []
    const camById = new Map([[init.entry.idA, init.cA], [init.entry.idB, init.cB]])
    for (const pt of init.points) {
      pt.views.forEach((kpIdx, uuid) => {
        const cam = camById.get(uuid)
        const img = imageByUuid(uuid)
        if (!cam || !img) return
        const kp = img.keypoints?.[kpIdx]
        if (!kp) return
        const proj = projectPoint(cam, pt.x, pt.y, pt.z)
        if (!proj) return
        residuals.push(Math.hypot(proj.u - kp.x, proj.v - kp.y))
      })
    }
    return numStats(residuals)
  }

  async function tryInitPair(entry) {
    const iA = imageByUuid(entry.idA)
    const iB = imageByUuid(entry.idB)
    if (!iA || !iB || !entry.F) return { ok: false, reason: 'missing image or fundamental matrix' }
    const KA = Kmap.get(entry.idA)
    const KB = Kmap.get(entry.idB)
    const E = fundamentalToEssential(entry.F, KA, KB)
    const esv = essentialSingularValues(E)
    const matches = entry.matches // [[ia, ib], ...]
    const pa = matches.map(([ia]) => iA.keypoints[ia])
    const pb = matches.map(([, ib]) => iB.keypoints[ib])
    const pose = await recoverPose(pa, pb, E, KA)
    if (!pose) return { ok: false, reason: 'pose recovery (essential decomposition) failed' }

    const cA = { R: I3, t: [0, 0, 0], K: KA }
    const cB = { R: pose.R, t: pose.t, K: KB }
    const PA = camToP34flat(cA)
    const PB = camToP34flat(cB)
    const tri = await triangulateDlt(
      pa.map((p) => toNorm(p.x, p.y, KA)),
      pb.map((p) => toNorm(p.x, p.y, KB)),
      PA, PB,
    )
    const points = []
    for (const { x, y, z, srcIdx } of tri) {
      if (projDepth(PA, x, y, z) > 0 && projDepth(PB, x, y, z) > 0) {
        const [ia, ib] = matches[srcIdx]
        points.push({ x, y, z, views: new Map([[entry.idA, ia], [entry.idB, ib]]) })
      }
    }
    const angle = medianTriangulationAngle(cA, cB, points)
    return {
      ok: true, entry, iA, iB, cA, cB, points, angle, esv,
      inliers: entry.inlierCount, triCount: tri.length, cheiralKept: points.length,
    }
  }

  // ── Select initial pair: enough inliers AND a wide-enough baseline ──────
  // Picking purely by inlier count tends to choose near-identical viewpoints
  // (tiny parallax) whose triangulated points collapse onto a line. Probe the
  // top candidates and take the first with adequate parallax.
  const { minInitInliers = 15, minInitAngleDeg = 2.0, initCandidates = 8 } = settings
  const candidates = donePairs
    .filter((e) => e.inlierCount >= minInitInliers
      && Kmap.has(e.idA) && Kmap.has(e.idB) && e.F)
    .sort((a, b) => b.inlierCount - a.inlierCount)
    .slice(0, initCandidates)

  log(`Reconstruction: ${candidates.length} init candidate(s) of ${donePairs.length} done pairs `
    + `(≥${minInitInliers} inliers, need ≥${minInitAngleDeg}° parallax)`, 'info', 'Reconstruction')

  if (candidates.length === 0) {
    log('Reconstruction: no valid matched pair found — check inlier counts and metadata', 'warn', 'Reconstruction')
    return { status: 'idle' }
  }

  // Probe *every* candidate (don't stop at the first adequate one) so we can both
  // log the full table and pick the geometrically cleanest seed. A seed's init
  // reprojection is the single best predictor of how well the model will grow:
  // a wide-baseline, low-reprojection pair gives clean 3D points that PnP can
  // then register against. Picking the first pair over the parallax floor — as
  // before — often locks in a noisy seed that stalls registration.
  const viable = []
  // Init-pair scoring is otherwise a silent stretch with the bar dead at 0 (no
  // cameras yet); emit a throttled label-only tick so the user sees it working.
  let lastEmit = 0
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  for (let ci = 0; ci < candidates.length; ci++) {
    const entry = candidates[ci]
    if (onProgress) {
      const t = nowMs()
      if (t - lastEmit >= 250) { lastEmit = t; onProgress(ci, candidates.length) }
    }
    const init = await tryInitPair(entry)
    const nameA = imageByUuid(entry.idA)?.name ?? entry.idA
    const nameB = imageByUuid(entry.idB)?.name ?? entry.idB
    if (!init.ok) {
      log(`Reconstruction: candidate ${nameA} ↔ ${nameB} rejected — ${init.reason}`, 'debug', 'Reconstruction')
      continue
    }
    // Cheirality survival = how many triangulated points are in front of both
    // cameras. A low ratio almost always means the recovered pose is wrong.
    const kept = init.cheiralKept, tri = init.triCount
    const pct = tri ? (100 * kept / tri).toFixed(0) : '0'
    if (kept < 10) {
      log(`Reconstruction: candidate ${nameA} ↔ ${nameB} rejected — only ${kept}/${tri} pts `
        + `survived cheirality (${pct}%), need ≥10`, 'debug', 'Reconstruction')
      continue
    }
    init.reproj = initReprojStats(init)
    init.nameA = nameA
    init.nameB = nameB
    const candRatio = init.esv.s1 > 0 ? init.esv.s2 / init.esv.s1 : 0
    log(`Reconstruction: candidate ${nameA} ↔ ${nameB} — ${init.inliers} inliers, `
      + `${kept}/${tri} pts kept after cheirality (${pct}%), median parallax ${init.angle.toFixed(2)}°, `
      + `init reproj median ${init.reproj.median.toFixed(2)}px, E σ2/σ1 ${candRatio.toFixed(2)}`,
      'debug', 'Reconstruction')
    viable.push(init)
  }

  // Per-pair init reprojection (for the run summary / cross-run comparison).
  const perPairInitReproj = viable.map((v) => ({
    pair: `${v.nameA} ↔ ${v.nameB}`,
    medianPx: v.reproj.median,
    parallaxDeg: v.angle,
  }))

  // Among candidates clearing the parallax floor, pick the best-*conditioned* seed —
  // NOT simply the lowest init reprojection. Reprojection alone biases hard toward
  // near-zero-parallax pairs: a two-view fit trivially explains a tiny baseline (points
  // collapse along the epipolar geometry, reproj ~1px) yet those points are depth-
  // uncertain and stall registration — the 2026-07 building seed picked 2.57°/2.26px over
  // 9.8°/100%-cheirality pairs, seeding a model that only reached 17/50 cameras. Score
  // each seed by the count of points that survived cheirality (pose correctness × scene
  // coverage) weighted by a parallax-health factor that saturates at initAngleTargetDeg
  // (a wider baseline stops helping past the sweet spot, and grazing >4× baselines — low
  // overlap — are mildly discounted), divided by a gentle reprojection penalty. Reprojection
  // is a weak signal here (it is measured before any distortion self-cal), so it only
  // breaks ties / rejects the wrong-pose high-reproj seeds cheirality misses; it never
  // dominates. If none clear the floor, fall back to the widest baseline available.
  const { initAngleTargetDeg = 8 } = settings
  const parallaxHealth = (a) => {
    if (a <= minInitAngleDeg) return 0
    if (a < initAngleTargetDeg) return (a - minInitAngleDeg) / (initAngleTargetDeg - minInitAngleDeg)
    const wide = initAngleTargetDeg * 4 // grazing baselines: overlap decays, so does benefit
    return a <= wide ? 1 : Math.max(0.4, wide / a)
  }
  const seedScore = (v) => v.cheiralKept * parallaxHealth(v.angle) / (1 + v.reproj.median / 4)
  const adequate = viable.filter((v) => v.angle >= minInitAngleDeg)
  let best = null
  if (adequate.length) {
    best = adequate.reduce((a, b) => (seedScore(b) > seedScore(a) ? b : a))
    log(`Reconstruction: selected seed ${best.nameA} ↔ ${best.nameB} of ${adequate.length} `
      + `pair(s) over ${minInitAngleDeg}° parallax (best-conditioned: ${best.cheiralKept} pts, `
      + `${best.angle.toFixed(2)}° parallax, init reproj median ${best.reproj.median.toFixed(2)}px)`,
      'info', 'Reconstruction')
  } else if (viable.length) {
    best = viable.reduce((a, b) => (b.angle > a.angle ? b : a))
  }

  if (!best) {
    log('Reconstruction: pose recovery failed for all candidate pairs '
      + '(toggle "Detail" in the console to see per-candidate reasons)', 'error', 'Reconstruction')
    return { status: 'error' }
  }
  if (best.angle < minInitAngleDeg) {
    log(`Reconstruction: best initial parallax is only ${best.angle.toFixed(2)}° `
      + `(< ${minInitAngleDeg}°) — the sparse cloud may look flat/linear`, 'warn', 'Reconstruction')
  }

  return { status: 'ok', best, perPairInitReproj }
}
