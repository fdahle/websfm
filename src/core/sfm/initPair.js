import { fundamentalToEssential, recoverPose, triangulateDlt } from './reconstruction.js'
import { hasKp, kpX, kpY } from './keypointSet.js'
import { I3, essentialSingularValues } from './rotations.js'
import { toNorm, camToP34flat } from './tracks.js'
import { projectPoint, medianTriangulationAngle } from './geometry.js'

// Initial-pair selection, lifted verbatim out of reconstruct(). A two-view seed
// is the single best predictor of how well the model grows, so we probe every
// candidate (pose recovery + triangulation + cheirality + init reprojection) and
// pick a geometrically sound seed whose points are already reusable by third views,
// rather than the highest-inlier pair. Pure: the reconstruct-local helpers it needs
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
        if (!hasKp(img.kp, kpIdx)) return
        const proj = projectPoint(cam, pt.x, pt.y, pt.z)
        if (!proj) return
        residuals.push(Math.hypot(proj.u - kpX(img.kp, kpIdx), proj.v - kpY(img.kp, kpIdx)))
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
    const pa = matches.map(([ia]) => ({ x: kpX(iA.kp, ia), y: kpY(iA.kp, ia) }))
    const pb = matches.map(([, ib]) => ({ x: kpX(iB.kp, ib), y: kpY(iB.kp, ib) }))
    const pose = await recoverPose(pa, pb, E, KA, KB)
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
        const [ia, ib] = matches.at ? matches.at(srcIdx) : matches[srcIdx]
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
  // top candidates and score every one that recovers a valid pose.
  const { minInitInliers = 15, minInitAngleDeg = 2.0, initCandidates = 24, excludedInitPairs = [] } = settings
  const excluded = new Set(excludedInitPairs)
  const pairId = (a, b) => (a < b ? `${a}--${b}` : `${b}--${a}`)
  const candidates = donePairs
    .filter((e) => e.inlierCount >= minInitInliers
      && Kmap.has(e.idA) && Kmap.has(e.idB) && e.F && !excluded.has(pairId(e.idA, e.idB)))
    .sort((a, b) => b.inlierCount - a.inlierCount)
    .slice(0, initCandidates)

  log(`${candidates.length} init candidate(s) of ${donePairs.length} done pairs `
    + `(≥${minInitInliers} inliers, need ≥${minInitAngleDeg}° parallax)`, 'info', 'Reconstruction')

  if (candidates.length === 0) {
    log('no valid matched pair found — check inlier counts and metadata', 'warn', 'Reconstruction')
    return { status: 'idle' }
  }

  // Match-graph degree per image, for the seed's connectivity health (scored below).
  const degree = new Map()
  for (const e of donePairs) {
    degree.set(e.idA, (degree.get(e.idA) ?? 0) + 1)
    degree.set(e.idB, (degree.get(e.idB) ?? 0) + 1)
  }
  const degs = [...degree.values()].sort((a, b) => a - b)
  const medianDegree = degs.length ? degs[degs.length >> 1] : 0
  const pairDegree = (entry) => Math.min(degree.get(entry.idA) ?? 0, degree.get(entry.idB) ?? 0)

  // Count the third images that can already draw enough *distinct seed points* for
  // PnP. Graph degree only says that the seed images have neighbours; it does not say
  // whether those edges reuse the seed pair's triangulated features. This is the direct
  // one-step growth signal we actually care about: a seed with many nominal edges but
  // no third view observing its 3D points cannot grow.
  function seedGrowth(init) {
    const seedPointByView = new Map([[init.entry.idA, new Map()], [init.entry.idB, new Map()]])
    init.points.forEach((pt, pointIdx) => pt.views.forEach((kpIdx, uuid) => {
      seedPointByView.get(uuid)?.set(kpIdx, pointIdx)
    }))
    const pointsByThirdView = new Map()
    for (const edge of donePairs) {
      let seedUuid, thirdUuid, seedSide
      if (seedPointByView.has(edge.idA) && !seedPointByView.has(edge.idB)) {
        seedUuid = edge.idA; thirdUuid = edge.idB; seedSide = 0
      } else if (seedPointByView.has(edge.idB) && !seedPointByView.has(edge.idA)) {
        seedUuid = edge.idB; thirdUuid = edge.idA; seedSide = 1
      } else continue
      let seen = pointsByThirdView.get(thirdUuid)
      if (!seen) { seen = new Set(); pointsByThirdView.set(thirdUuid, seen) }
      const pointByKp = seedPointByView.get(seedUuid)
      for (const match of edge.matches ?? []) {
        const pointIdx = pointByKp.get(match[seedSide])
        if (pointIdx != null) seen.add(pointIdx)
      }
    }
    const need = settings.minMatchesForRegistration ?? 20
    const counts = [...pointsByThirdView.values()].map((seen) => seen.size)
    const ready = counts.filter((n) => n >= need)
    return {
      views: ready.length,
      correspondences: ready.reduce((sum, n) => sum + n, 0),
      maxCorrespondences: counts.length ? Math.max(...counts) : 0,
    }
  }

  // ── Seed scoring ───────────────────────────────────────────────────────────
  // Parallax is a GATE, not a ranking. Above a soft band just over the floor every
  // candidate's baseline counts as "sufficient" and the seed is decided by the
  // signals that actually predict how the model grows: cheirality-surviving point
  // count, init reprojection, graph connectivity. This is COLMAP's stance, and the
  // arithmetic forces it — a ramp anchored at the floor turns small absolute angle
  // gaps into large multiplicative ones. South Building (HANDOVER §B4): the old
  // ramp scored 5.21° over 2.68° by (5.21−2)/(2.68−2) = 4.7×, swamping the correct
  // seed's combined 1.34× edge (640 vs 496 points, 0.63 vs 0.79px init reproj,
  // graph degree 21 vs 18). It seeded 19/128 cameras with a self-cal that ran away
  // to fx +101%, while the pair it beat reached 122/128. No compressed curve fixes
  // that (linear-through-origin still 1.94×, sqrt 1.39×) — parallax had to stop
  // being ranked at all.
  //
  // The risk that flattening parallax hands the ranking to raw point count was real,
  // and it fired on the very next SB run (2026-07-22): with both candidates gated to
  // 1.0, a 1177-point pair at graph degree 7 beat a 670-point hub at degree 22 and
  // registered 3/128 cameras, where the hub reached 86. Hence the two dampers below —
  // sqrt on the point count, and a connectivity term that rewards above-median degree
  // instead of capping at it. Degree is the signal that separated the good seed from
  // the bad one on every measured run; point count separated neither.
  //
  // Still-open risk: a barely-passing pair winning on the flat gate. Two things guard
  // it — the `adequate` floor filter, and the soft band below `softFloorDeg` where a
  // barely-passing pair is discounted (no cliff at exactly minInitAngleDeg). If a
  // low-parallax seed does win badly on real data, the term to add is the E-matrix
  // conditioning σ2/σ1 (already computed and logged per candidate) — with measured
  // evidence behind its shape, not a guess.
  const {
    initAngleTargetDeg = 8, initConnFloor = 0.4, initConnCeil = 2, initSoftFloorFactor = 1.25,
  } = settings
  // initAngleTargetDeg no longer names a ramp target — it survives only as the knee
  // (×4) past which a grazing baseline's decaying overlap starts to cost more than
  // its extra parallax buys.
  const softFloorDeg = minInitAngleDeg * initSoftFloorFactor
  const parallaxHealth = (a) => {
    if (a <= minInitAngleDeg) return 0
    if (a < softFloorDeg) return 0.5 + 0.5 * (a - minInitAngleDeg) / (softFloorDeg - minInitAngleDeg)
    const wide = initAngleTargetDeg * 4
    return a <= wide ? 1 : Math.max(0.4, wide / a)
  }

  // Connectivity health: how well-connected the seed's two images are in the match graph,
  // relative to the median image. A geometrically perfect pair inside a small, weakly-
  // attached sub-block (e.g. the building set's close-range tail images, which match each
  // other by 1000+ inliers but reach the main block only through a few edges) seeds a model
  // that grows into a corner and stalls — the 2026-07-17 baseline picked exactly such a
  // seed and stalled at 3 cameras, while COLMAP seeded mid-sequence and registered 50/50.
  //
  // It REWARDS above-median degree rather than capping at it. Capping was measured wrong
  // on South Building (2026-07-22): a degree-7 pair (below the median 8) and a degree-22
  // hub both scored ~1, so the hub's real advantage was invisible and a stranded pair with
  // more raw points won — 3 registered cameras versus the hub's 86. Degree is the signal
  // that separated the good seed from the bad one on every measured run, so it gets a
  // range, not a ceiling: floored at initConnFloor (a great pair in a thin neighbourhood
  // is still a candidate) and capped at initConnCeil so one freak hub can't buy the seed
  // outright. On a uniformly-connected graph every seed scores 1 and this is inert.
  const connectivityHealth = (v) => (medianDegree
    ? Math.min(initConnCeil, Math.max(initConnFloor, pairDegree(v.entry) / medianDegree))
    : 1)

  // Point count enters as a SQUARE ROOT, not linearly. A pair with 2× the surviving points
  // is better conditioned but not twice as likely to grow the model — and taken linearly it
  // simply ranks by match count, which is how South Building's 1177-point stranded pair beat
  // a 670-point hub. Compressing it keeps it a real signal while leaving room for the graph
  // terms to overrule it.
  //
  // Reprojection is a weak signal (it is measured before any distortion self-cal), so it
  // only breaks ties and rejects the wrong-pose high-reproj seeds cheirality misses; it
  // never dominates.
  // Once geometry has passed its gates, each independently PnP-ready view is a real
  // opportunity for the model to grow. Keep this proportional instead of logarithmic:
  // the 2026-07-22 browser run measured 23 ready views on the 123-camera seed versus 20
  // on a seed that stalled at 3, yet log compression reduced that evidence to only 1.04×
  // and let point count pick the stalled seed. Zero/one both map to 1 so sparse graphs
  // retain the geometry-only behaviour.
  const growthHealth = (v) => Math.max(1, v.growth.views)
  const seedScore = (v) => Math.sqrt(v.cheiralKept) * parallaxHealth(v.angle)
    * connectivityHealth(v) * growthHealth(v) / (1 + v.reproj.median / 4)

  // Probe *every* candidate (don't stop at the first adequate one) so we can both log
  // the full table and score them against each other. Picking the first pair over the
  // parallax floor locks in whatever the candidate ordering happened to surface first,
  // which is how a noisy seed stalls a whole reconstruction.
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
      log(`candidate ${nameA} ↔ ${nameB} rejected — ${init.reason}`, 'debug', 'Reconstruction')
      continue
    }
    // Cheirality survival = how many triangulated points are in front of both
    // cameras. A low ratio almost always means the recovered pose is wrong.
    const kept = init.cheiralKept, tri = init.triCount
    const pct = tri ? (100 * kept / tri).toFixed(0) : '0'
    if (kept < 10) {
      log(`candidate ${nameA} ↔ ${nameB} rejected — only ${kept}/${tri} pts `
        + `survived cheirality (${pct}%), need ≥10`, 'debug', 'Reconstruction')
      continue
    }
    init.reproj = initReprojStats(init)
    init.nameA = nameA
    init.nameB = nameB
    init.growth = seedGrowth(init)
    init.score = seedScore(init)
    const candRatio = init.esv.s1 > 0 ? init.esv.s2 / init.esv.s1 : 0
    // Log the score AND its factors: a seed decision that can only be re-derived by
    // hand from raw candidate numbers is what made the B4 post-mortem manual.
    log(`candidate ${nameA} ↔ ${nameB} — ${init.inliers} inliers, `
      + `${kept}/${tri} pts kept after cheirality (${pct}%), median parallax ${init.angle.toFixed(2)}°, `
      + `init reproj median ${init.reproj.median.toFixed(2)}px, E σ2/σ1 ${candRatio.toFixed(2)}, `
      + `graph degree ${pairDegree(entry)} (median ${medianDegree}) `
      + `⇒ score ${init.score.toFixed(1)} (parallax ×${parallaxHealth(init.angle).toFixed(2)}, `
      + `connectivity ×${connectivityHealth(init).toFixed(2)}, `
      + `growth ×${growthHealth(init).toFixed(2)} from ${init.growth.views} PnP-ready view(s))`,
      'debug', 'Reconstruction')
    viable.push(init)
  }

  // Among candidates clearing the parallax floor take the highest-scoring seed (see the
  // scoring block above). If none clear it, fall back to the widest baseline available.
  const adequate = viable.filter((v) => v.angle >= minInitAngleDeg)
  let best = null
  if (adequate.length) {
    best = adequate.reduce((a, b) => (b.score > a.score ? b : a))
    // Name the runner-up and its score: a 1.3× margin is worth trusting, a 1.02× one
    // is worth a second look, and neither is visible from the winner's numbers alone.
    const rest = adequate.filter((v) => v !== best)
    const second = rest.length ? rest.reduce((a, b) => (b.score > a.score ? b : a)) : null
    log(`selected seed ${best.nameA} ↔ ${best.nameB} of ${adequate.length} `
      + `pair(s) over ${minInitAngleDeg}° parallax (score ${best.score.toFixed(1)}: `
      + `${best.cheiralKept} pts, ${best.angle.toFixed(2)}° parallax, `
      + `init reproj median ${best.reproj.median.toFixed(2)}px, `
      + `connectivity ${connectivityHealth(best).toFixed(2)} at graph degree ${pairDegree(best.entry)} `
      + `vs median ${medianDegree}, ${best.growth.views} PnP-ready view(s))`
      + (second ? ` — ahead of ${second.nameA} ↔ ${second.nameB} at ${second.score.toFixed(1)}` : ''),
      'info', 'Reconstruction')
  } else if (viable.length) {
    best = viable.reduce((a, b) => (b.angle > a.angle ? b : a))
  }

  // Per-pair init stats (for the run summary / cross-run comparison). Carries the full
  // seed decision — score and the inputs that produced it — so a run can be reviewed
  // without its console log.
  const perPairInitReproj = viable.map((v) => ({
    pair: `${v.nameA} ↔ ${v.nameB}`,
    medianPx: v.reproj.median,
    parallaxDeg: v.angle,
    score: v.score,
    cheiralKept: v.cheiralKept,
    degree: pairDegree(v.entry),
    growthViews: v.growth.views,
    growthCorrespondences: v.growth.correspondences,
    selected: v === best,
  }))

  if (!best) {
    log('pose recovery failed for all candidate pairs '
      + '(toggle "Detail" in the console to see per-candidate reasons)', 'error', 'Reconstruction')
    return { status: 'error' }
  }
  if (best.angle < minInitAngleDeg) {
    log(`best initial parallax is only ${best.angle.toFixed(2)}° `
      + `(< ${minInitAngleDeg}°) — the sparse cloud may look flat/linear`, 'warn', 'Reconstruction')
  }

  return { status: 'ok', best, perPairInitReproj }
}
