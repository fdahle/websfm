// Post-run verdict (usability track U6) — the cheap 20% of the processing report.
//
// Turn a finished reconstruction into a traffic light + a short, ORDERED list of
// actionable next-steps ("registered only 34/50 — lower minMatches or add overlap").
// The Quality Report hub (F8) already shows every number; this answers the one
// question a number grid does not: "is this good, and if not, what do I do?"
//
// Pure rule engine: plain snapshot in, plain verdict out (no Vue/Pinia/DOM), so F8
// and a future "Run All" summary can both reuse it. It colours off the SAME single
// `EVAL_THRESHOLDS` table the hub uses (health.js); the handful of constants below are
// verdict-only because each is a *shape* or *cross-field* test that no single-value
// health threshold can see (a ratio between two figures, or a share of a population).
//
// The last three rules are **contributing-cause** rules: they explain a finding that
// already fired rather than raising one of their own, and are deliberately silent
// otherwise. A run can saturate the keypoint cap, skip the rotation-cycle filter and
// leave the track filter inert while still being a perfectly good reconstruction —
// turning that green run yellow would be a false alarm. The unconditional record of
// all three lives in the digest (core/eval/summaryDigest.js), which is the run's
// *record*; the verdict is its *alarm*, and the two have different bars.

import { EVAL_THRESHOLDS, classify } from '../eval/health.js'

// A long reprojection tail relative to the median is the fingerprint of uncorrected
// lens distortion: the centre projects cleanly (low median) while the corners blow
// out (high p95). B1 (building set, pre-self-cal) showed exactly this — a ~1px median
// under a 282px p95 — which is what motivated the staged self-cal. 3× is comfortably
// clear of the ~2× spread a healthy solve shows, 5× is unambiguous.
const REPROJ_TAIL_WARN = 3
const REPROJ_TAIL_BAD = 5

// Verdict-only severity for the ≥3-view share: the hub *warns* below 60% (a
// geometrically thin block), but a run is only "weakly constrained enough to act on"
// once it drops under ~20% — B1's 9.5% was the pathological end.
const TRACK3_ACT_PCT = 20

// Track-filter gate ÷ observed reprojection p95. The gate is denominated in DETECTION
// pixels and resolved to native by the detection scale (core/scaleContext.js), so a low
// maxDim silently multiplies it: a 5472px sensor detected at 2400 gives ×2.28, putting a
// 4 detect-px filter at 9.12 native px against a 4.0 px p95. Past ~2× the gate sits above
// essentially every residual and the filter removes nothing, so a reprojection tail
// survives by construction rather than because the geometry is bad. Mirrored as
// GATE_HEADROOM_NOTE in summaryDigest.js.
const GATE_HEADROOM_WARN = 2

// Share of images at the keypoint cap above which the cap — not contrastThreshold — is
// what selected the keypoints. It selects by DoG response, which biases toward
// high-contrast texture and away from spatial uniformity, so a saturated cap is a
// plausible contributing cause of an uneven per-image residual spread. Mirrored as
// KP_CAP_NOTE_PCT in summaryDigest.js.
const KP_CAP_WARN_PCT = 90

// Share of accepted pairs flagged H/F-degenerate above which the match graph's geometry
// is substantially planar / rotation-dominated. F is not uniquely determined on planar
// correspondences, so the essential decomposition the rotation-cycle filter depends on
// returns an arbitrary member of a family — which is the competing explanation for a
// filter abort, against "the intrinsics were wrong".
const DEGENERATE_PAIR_WARN_PCT = 50

const worst = (a, b) => (a === 'red' || b === 'red' ? 'red' : a === 'yellow' || b === 'yellow' ? 'yellow' : 'green')

// Map a classify() tone ('ok'|'warn'|'bad'|'missing') to a verdict level, or null to
// skip (ok / missing prerequisite ⇒ no finding).
const toneToLevel = (t) => (t === 'bad' ? 'red' : t === 'warn' ? 'yellow' : null)

const pct = (v) => (v == null ? '—' : `${v.toFixed(0)}%`)
const px = (v) => (v == null ? '—' : `${v.toFixed(1)} px`)

/**
 * @typedef {object} VerdictSnapshot
 * @property {number} [imageCount]     total images in the project
 * @property {number} [registeredCount] cameras that registered (summary.nCameras)
 * @property {number} [nPoints]        triangulated points (for the degenerate check)
 * @property {number} [reprojMedianPx] final/post-BA reprojection median
 * @property {number} [reprojP95px]    reprojection p95 (the residual tail)
 * @property {number} [track3ViewPct]  ≥3-view track share, % (summary.pct3plusViewTracks)
 * @property {number} [graphComponents] match-graph component count (optional)
 * @property {number} [focalDeltaPct]  worst |Δ focal| vs nominal, % (optional)
 * @property {number} [depthCoveragePct] mean per-map valid-depth coverage, % (dense; optional)
 * @property {string} [selfCalResolved] actual sparse self-cal mode ('none', 'f,k1', …)
 * @property {number} [separateSecondaryModels] usable secondary models that could not be aligned
 * @property {Array<{name?: string, reason?: string}>} [unregistered] names to list in the fix
 * @property {number} [filterMaxReprojPx] resolved track-filter gate, native px (summary.gates)
 * @property {number} [detectScaleFactor] native-px ÷ detection-px factor (summary.gates)
 * @property {number} [maxDim] detection long-edge cap, px (detectConfig)
 * @property {number} [kpCapHitPct] share of images that hit the keypoint cap, %
 * @property {number} [maxKeypoints] the keypoint cap itself (for the fix text)
 * @property {boolean} [cycleFilterAborted] the rotation-cycle filter skipped itself
 * @property {number} [cycleMedianTriErrDeg] its measured median triangle cycle error
 * @property {number} [degeneratePairPct] share of accepted pairs flagged H/F-degenerate, %
 */

/**
 * @typedef {object} VerdictFinding
 * @property {'red'|'yellow'} level
 * @property {string} code    stable machine id (e.g. 'registration')
 * @property {string} title   one-line problem statement
 * @property {string} fix     what to try next
 */

/**
 * Build a post-run verdict.
 * @param {VerdictSnapshot} snapshot
 * @returns {{ level: 'green'|'yellow'|'red', headline: string, findings: VerdictFinding[] }}
 */
export function buildVerdict(snapshot = {}) {
  const s = snapshot
  const findings = []
  const add = (level, code, title, fix) => findings.push({ level, code, title, fix })

  const reg = s.registeredCount ?? null
  const total = s.imageCount ?? null

  // 1. Degenerate — a run that never left the ground. This is red regardless of
  //    every other number (they are survivor-biased on a 2-camera model).
  if ((reg != null && reg < 2) || s.nPoints === 0) {
    add('red', 'failed',
      'Reconstruction failed — too few cameras or no points.',
      'Check that images overlap and share texture; lower the matching floors (minMatches) and re-run detection at higher resolution.')
    // Nothing else is meaningful on a failed run — return early with just this.
    return finalize(findings)
  }

  // 2. Registered share.
  if (reg != null && total) {
    const regPct = (reg / total) * 100
    const level = toneToLevel(classify(regPct, EVAL_THRESHOLDS.registeredPct))
    if (level) {
      const missing = total - reg
      const names = (s.unregistered || []).map((u) => u.name).filter(Boolean).slice(0, 5)
      const listed = names.length ? ` (e.g. ${names.join(', ')}${missing > names.length ? ', …' : ''})` : ''
      const secondary = s.separateSecondaryModels > 0
        ? ` ${s.separateSecondaryModels} additional usable model(s) were reconstructed but could not be aligned to the primary.` : ''
      add(level, 'registration',
        `Only ${reg}/${total} images registered in the primary (${pct(regPct)})${listed}.${secondary}`,
        s.graphComponents > 1
          ? 'The verified match graph is split. Add bridging images, use exhaustive/pose preselection, or run targeted cross-component matching; lowering reconstruction gates cannot reconnect a split graph.'
          : 'Inspect the unregistered-image and self-calibration diagnostics first. Add overlap where correspondences are absent; only lower matching floors when the match graph itself is demonstrably too sparse.')
    }
  }

  // 3. Reprojection tail — distortion fingerprint (p95 ≫ median).
  const med = s.reprojMedianPx ?? null
  const p95 = s.reprojP95px ?? null
  if (med != null && p95 != null && med > 0) {
    const ratio = p95 / med
    const level = ratio >= REPROJ_TAIL_BAD ? 'red' : ratio >= REPROJ_TAIL_WARN ? 'yellow' : null
    if (level) {
      const selfCalKnown = s.selfCalResolved != null
      const selfCalActive = selfCalKnown && s.selfCalResolved !== 'none'
      const code = selfCalActive ? 'reprojection-tail' : 'distortion'
      const fix = selfCalActive
        ? 'Self-calibration already ran, so this ratio alone does not prove uncorrected distortion. Inspect the worst residual images and the spatial/radial residual plot; remove localized bad tracks or images, and only change the lens model if the residuals grow coherently toward the corners.'
        : 'This can indicate uncorrected lens distortion, but the ratio alone is not proof. Inspect residuals versus image radius; if they grow toward the corners, enable self-calibration or set a calibrated distortion model.'
      add(level, code,
        `Reprojection tail is ${ratio.toFixed(1)}× the median (median ${px(med)}, p95 ${px(p95)}).`,
        fix)
    }
  }

  // 4. Absolute reprojection median (a bad solve even without a tail).
  {
    const level = toneToLevel(classify(med, EVAL_THRESHOLDS.reprojMedianPx))
    if (level && !findings.some((f) => f.code === 'distortion' || f.code === 'reprojection-tail')) {
      add(level, 'reprojection',
        `Reprojection median is ${px(med)}.`,
        'Tighten the reprojection gate and add BA iterations (Reconstruct ▸ High), and remove any high-residual images.')
    }
  }

  // 5. Weakly constrained — dominated by 2-view points.
  const t3 = s.track3ViewPct ?? null
  if (t3 != null && t3 < TRACK3_ACT_PCT) {
    add('yellow', 'weak-geometry',
      `Only ${pct(t3)} of tie points are seen by ≥3 views — the model is geometrically thin.`,
      'Increase image overlap so more points are shared across three or more views; a set of near-stereo pairs cannot constrain the block well.')
  }

  // 6. Split match graph.
  const comp = s.graphComponents ?? null
  if (comp != null && comp > 1) {
    add('yellow', 'graph-split',
      `The match graph has ${comp} disconnected components.`,
      'The images fall into groups that share no matches — add bridging images/overlap, or reconstruct the groups separately.')
  }

  // 7. Focal disagreement (self-cal absorbed it, but the nominal was wrong).
  const focalLevel = toneToLevel(classify(s.focalDeltaPct ?? null, EVAL_THRESHOLDS.focalDeltaPct))
  if (focalLevel) {
    add(focalLevel, 'focal',
      `Refined focal differs from the nominal by ${pct(Math.abs(s.focalDeltaPct))}.`,
      'The EXIF focal or the entered sensor/film width is likely wrong. Self-cal recovered it, but correct the sensor for a cleaner next run.')
  }

  // 8. Dense depth-map coverage (only present after a dense run). A thin coverage
  //    means the depth maps kept few valid pixels — usually wrong intrinsics or too
  //    few source views, and it directly starves fusion / the DEM / the ortho.
  const depthLevel = toneToLevel(classify(s.depthCoveragePct ?? null, EVAL_THRESHOLDS.depthCoveragePct))
  if (depthLevel) {
    add(depthLevel, 'depth-coverage',
      `Depth maps kept only ${pct(s.depthCoveragePct)} of pixels on average.`,
      'Increase the source-view count and check the intrinsics are right (a wrong focal wrecks depth); raising depth-map quality also helps on weak texture.')
  }

  // ── Contributing causes ────────────────────────────────────────────────────
  // Each of the following explains a finding that already fired. See the header: they
  // are silent on an otherwise-clean run, because none of them is a defect on its own.
  const fired = (...codes) => findings.some((f) => codes.includes(f.code))
  const residualFinding = () => fired('reprojection-tail', 'distortion', 'reprojection')
  const structuralFinding = () => fired(
    'reprojection-tail', 'distortion', 'reprojection', 'registration', 'weak-geometry')

  // 9. Inert track filter. Ordered directly after the residual rules because when both
  //    fire this is the actionable one: the tail was never filtered, so "the residuals
  //    are bad" and "nothing removed the bad residuals" are the same observation.
  if (p95 != null && p95 > 0 && s.filterMaxReprojPx != null && residualFinding()) {
    const headroom = s.filterMaxReprojPx / p95
    if (headroom >= GATE_HEADROOM_WARN) {
      const scale = s.detectScaleFactor
      const scaleNote = scale != null && scale > 1.2
        ? ` The gate is set in detection pixels and scaled ×${scale.toFixed(2)} to native, `
          + `because detection ran at maxDim ${s.maxDim ?? '?'} on a larger sensor — `
          + 'raising maxDim shrinks the factor and tightens every gate with it.'
        : ''
      add('yellow', 'gate-headroom',
        `The track filter gate (${px(s.filterMaxReprojPx)}) sits ${headroom.toFixed(1)}× above the `
          + `observed p95 (${px(p95)}), so it removed essentially nothing.`,
        `The residual tail above survived the filter by construction, not because the geometry is sound.${scaleNote}`
          + ' Raise detection resolution or lower filterMaxReprojDetectPx, then re-run and compare the tail.')
    }
  }

  // 10. Saturated keypoint cap.
  if (s.kpCapHitPct != null && s.kpCapHitPct >= KP_CAP_WARN_PCT && structuralFinding()) {
    add('yellow', 'keypoint-cap',
      `${pct(s.kpCapHitPct)} of images hit the ${s.maxKeypoints ?? 'keypoint'} keypoint cap.`,
      'The cap, not contrastThreshold, is selecting the keypoints, and it selects by response — '
        + 'biasing toward high-contrast texture and away from even spatial coverage. Raise maxKeypoints, '
        + 'or raise contrastThreshold so the threshold does the selecting.')
  }

  // 11. Rotation-cycle filter skipped. Reported with the degeneracy share because that
  //     share is what distinguishes its two possible causes, and they have opposite fixes.
  if (s.cycleFilterAborted && structuralFinding()) {
    const dg = s.degeneratePairPct
    const planar = dg != null && dg >= DEGENERATE_PAIR_WARN_PCT
    add('yellow', 'cycle-filter-skipped',
      `The rotation-cycle filter skipped itself — median triangle cycle error `
        + `${s.cycleMedianTriErrDeg != null ? `${s.cycleMedianTriErrDeg.toFixed(0)}°` : 'above its ceiling'}`
        + `, so false pairs were not screened before SfM.`,
      planar
        ? `${pct(dg)} of accepted pairs are H/F-degenerate (planar scene or rotation-dominated motion), `
          + 'where the fundamental matrix is not uniquely determined and the filter\'s pairwise rotations '
          + 'are meaningless. This is expected on nadir aerial blocks and is not fixable by calibration; '
          + 'rely on the PnP gates downstream.'
        : 'With few degenerate pairs the likelier cause is wrong intrinsics (focal or lens distortion) '
          + 'feeding the essential decomposition. Check the fx trajectory and the composed radial terms; '
          + 'a correct sensor definition lets the filter run.')
  }

  return finalize(findings)
}

function finalize(findings) {
  // Worst-first ordering; within a level, keep insertion order (already priority-sorted).
  const rank = { red: 0, yellow: 1 }
  findings.sort((a, b) => rank[a.level] - rank[b.level])

  const level = findings.reduce((acc, f) => worst(acc, f.level), 'green')
  const nRed = findings.filter((f) => f.level === 'red').length
  const nYellow = findings.length - nRed
  let headline
  if (level === 'green') headline = 'Looks good — no issues detected.'
  else if (level === 'red') headline = `Serious problems — ${nRed} to fix${nYellow ? `, ${nYellow} to check` : ''}.`
  else headline = `Usable, but ${nYellow} thing${nYellow === 1 ? '' : 's'} worth checking.`

  return { level, headline, findings }
}
