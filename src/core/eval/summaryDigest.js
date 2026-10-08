// Compact, copy-pasteable project digest (PLAN-debug-summary). A second *view* of
// the same numbers the Quality Report hub shows — it consumes the already-classified
// `projectHealth` rows plus the raw snapshot, so it can never disagree with the hub
// (see composables/useQualityReport.js). Pure: no Vue/DOM/store imports, plain data in,
// a structured digest object out, rendered to markdown OR JSON by the two renderers.
//
// The motivating use: a large run's log is too long to skim for "did this succeed?",
// so the user copies this ~30-50 line digest instead. Markdown for reading, JSON for
// precise machine parsing — same content, the modal lets the user pick.

// A second, equally important use (added 2026-07-25): the **baseline record**. The
// owed verification runs in TODO.md are all "dataset × settings → numbers", and a
// number without its settings is not a baseline. So the digest also states what was
// run (`config`) and the stage decisions the final numbers hide (`diagnostics`: which
// seed won and on which attempt, the focal trajectory, the resolved pixel gates, the
// match gate accounting, per-stage wall clock). Everything
// here is *reported*, never derived a second way — each field traces to one producer.
//
// Input:
//   {
//     projectName, date, crsUnit,
//     rows:      projectHealth() output [{ id, section, label, value, unit, status, hint }],
//     snapshot:  the plain health snapshot (raw figures behind the rows),
//     offenders: { residuals:[{ name, nObs, rmsPx }], unregistered:[{ name, reason }] },
//     summary:      recon.summary      | null (sparse run: figures + config/gates/seed/selfCal/timings),
//     denseSummary: recon.denseSummary | null (Stage B fusion figures),
//     depthSummary: recon.depthSummary | null (Stage A depth-map run record),
//     detect:       derived detection config | null (see useQualityReport — the settings
//                   ride on each image, so the caller reduces them to one row + a
//                   `mixed` flag rather than this module guessing),
//     matchRun:     matchesStore.matchRun | null (last match run: settings + gate tally),
//     verdict:      buildVerdict() output | null (core/sfm/verdict.js),
//   }
// → digest: { project, date, crsUnit, status, verdict, health, offenders, config,
//             diagnostics, run }
export function buildProjectDigest(input = {}) {
  const {
    projectName = 'untitled',
    date = new Date().toISOString(),
    crsUnit = 'm',
    rows = [],
    snapshot = null,
    offenders = {},
    summary = null,
    denseSummary = null,
    depthSummary = null,
    detect = null,
    matchRun = null,
    verdict = null,
    scaleFit = null,
  } = input

  // Status roll-up across the classified health rows.
  const status = { ok: 0, warn: 0, bad: 0, missing: 0 }
  for (const r of rows) {
    if (r.status in status) status[r.status]++
  }
  // A single word for the whole project: the worst present tone wins.
  status.healthOverall = status.bad ? 'bad' : status.warn ? 'warn' : status.ok ? 'ok' : 'unknown'
  // The action-oriented verdict includes shape/cross-field checks that are not health
  // rows (for example a severe reprojection tail). The exported top-level status must
  // never be greener than that verdict, otherwise one JSON object contradicts itself.
  const verdictTone = verdict?.level === 'red' ? 'bad' : verdict?.level === 'yellow' ? 'warn'
    : verdict?.level === 'green' ? 'ok' : 'unknown'
  const toneRank = { unknown: 0, ok: 1, warn: 2, bad: 3 }
  status.overall = toneRank[verdictTone] > toneRank[status.healthOverall]
    ? verdictTone : status.healthOverall

  // Group the health rows by section, preserving first-seen order.
  const sectionOrder = []
  const bySection = new Map()
  for (const r of rows) {
    const key = r.section || 'other'
    if (!bySection.has(key)) { bySection.set(key, []); sectionOrder.push(key) }
    bySection.get(key).push({
      label: r.label, value: r.value, unit: r.unit || '',
      status: r.status, hint: r.hint || '',
    })
  }
  const health = sectionOrder.map((section) => ({ section, rows: bySection.get(section) }))

  return {
    project: projectName,
    date,
    crsUnit,
    status,
    verdict: verdict
      ? {
        level: verdict.level ?? null,
        headline: verdict.headline ?? null,
        findings: (verdict.findings || []).map((f) => ({
          level: f.level, code: f.code, title: f.title, fix: f.fix ?? null,
        })),
      }
      : null,
    health,
    offenders: {
      residuals: (offenders.residuals || []).map((r) => ({
        name: r.name, nObs: r.nObs ?? null, rmsPx: r.rmsPx ?? null,
      })),
      unregistered: (offenders.unregistered || []).map((r) => ({
        name: r.name, reason: r.reason || 'unknown',
      })),
    },
    // What was run. Each stage is null when that stage has no record — an unknown
    // setting must never render as a default, or a digest would claim settings the
    // run did not use.
    config: {
      detect: detect
        ? {
          detector: detect.detector ?? null,
          images: detect.images ?? null,
          maxDim: detect.maxDim ?? null,
          maxDimMode: detect.maxDimMode ?? null,
          maxKeypoints: detect.maxKeypoints ?? null,
          contrastThreshold: detect.contrastThreshold ?? null,
          tiling: detect.tiling ?? null,
          // SIFT keypoints per extremum; absent on older records ⇒ not rendered.
          ...(detect.maxOrientations != null ? { maxOrientations: detect.maxOrientations } : {}),
          // Which keypoints the SIFT cap kept; absent on older records ⇒ not rendered.
          ...(detect.capRule != null ? { capRule: detect.capRule } : {}),
          medianKeypoints: detect.medianKeypoints ?? null,
          medianDetectScale: detect.medianDetectScale ?? null,
          kpCapHitPct: detect.kpCapHitPct ?? null,
          mixed: !!detect.mixed,
        }
        : null,
      match: matchRun
        ? {
          strategy: matchRun.strategy ?? null,
          matcher: matchRun.matcher ?? null,
          // Brute-force backend ('wasm' | 'gpu' | 'gpu→wasm'); absent on runs that
          // predate it, so it renders as absent rather than a guessed 'wasm'.
          ...(matchRun.backend?.backend ? { backend: matchRun.backend.backend } : {}),
          pairs: matchRun.nPairs ?? null,
          ...(matchRun.settings || {}),
        }
        : null,
      sparse: summary?.config ? { ...summary.config } : null,
      dense: depthSummary?.settings ? { ...depthSummary.settings } : null,
    },
    // Stage decisions the headline figures hide.
    diagnostics: {
      seed: summary?.initPair ? { ...summary.initPair } : null,
      attempts: summary?.attempts ? { ...summary.attempts } : null,
      // The resolved gates, plus the residual distribution they were applied to. A gate
      // in isolation says nothing — 9.12 px is tight on one dataset and inert on
      // another; only "gate vs observed p95" says whether the track filter had anything
      // to bite on. Both figures are *reported* (sfm.js resolved the gate, reconStats
      // measured the p95); the digest only puts them on one line.
      gates: summary?.gates
        ? { ...summary.gates, observedP95px: snapshot?.reproj?.p95 ?? null }
        : null,
      selfCal: summary?.selfCal ? { ...summary.selfCal } : null,
      intrinsics: summary?.intrinsics ? summary.intrinsics.map((r) => ({ ...r })) : [],
      selfCalDistortion: summary?.selfCalDistortion
        ? summary.selfCalDistortion.map((r) => ({ ...r })) : [],
      // Final-stage track completion passes (absent on runs that predate it).
      trackCompletion: Array.isArray(summary?.trackCompletion)
        ? summary.trackCompletion.map((r) => ({ ...r })) : null,
      secondaryRecovery: summary?.secondaryRecovery ? { ...summary.secondaryRecovery } : null,
      fingerprints: input.fingerprints ? { ...input.fingerprints } : null,
      // Match gate accounting: the tally, not the settings (those are in config.match).
      matchGates: matchRun
        ? {
          pairs: matchRun.nPairs ?? null,
          accepted: matchRun.accepted ?? null,
          weak: matchRun.weak ?? null,
          rejected: matchRun.rejected ?? null,
          skipped: matchRun.skipped ?? null,
          gated: matchRun.gated ?? null,
          degenerate: matchRun.degenerate ?? null,
          degenerateOf: matchRun.degenerateOf ?? null,
          subsetGateActive: !!matchRun.subsetGateActive,
          meanInlierRatio: matchRun.meanInlierRatio ?? null,
          inliers: matchRun.inliers ?? null,
          resolvedRansacPx: matchRun.resolvedRansacPx ?? null,
        }
        : null,
      timings: summary?.timings ? { ...summary.timings } : null,
      baSolver: summary?.baSolver ? { ...summary.baSolver } : null,
    },
    run: {
      sparse: summary ? {
        cameras: summary.nCameras ?? null,
        points: summary.nPoints ?? null,
        pct3plusViewTracks: summary.pct3plusViewTracks ?? null,
        preBaP95px: summary.preBaP95px ?? null,
        postBaMedianPx: summary.postBaMedianPx ?? null,
      } : null,
      dense: denseSummary ? {
        costMedian: denseSummary.costMedian ?? null,
        keptPct: denseSummary.keptPct ?? null,
        mergeCell: denseSummary.mergeCell ?? null,
        cullBreakdown: denseSummary.cullBreakdown ?? null,
      } : null,
      depth: depthSummary ? {
        maps: depthSummary.nMaps ?? null,
        backend: depthSummary.backend ?? null,
        gpuFallbacks: depthSummary.gpuFallbacks ?? null,
        medianMsPerImage: depthSummary.medianMsPerImage ?? null,
        totalMs: depthSummary.totalMs ?? null,
        medianCoveragePct: depthSummary.medianCoveragePct ?? null,
        medianCostMedian: depthSummary.medianCostMedian ?? null,
        geomFilterMs: depthSummary.geomFilterMs ?? null,
        geomFilterMedianKeptPct: depthSummary.geomFilterMedianKeptPct ?? null,
        geomFilterMinKeptPct: depthSummary.geomFilterMinKeptPct ?? null,
        geomFilterMarginalMaps: depthSummary.geomFilterMarginalMaps ?? null,
        projectedPeakBytes: depthSummary.projectedPeakBytes ?? null,
        budgetBytes: depthSummary.budgetBytes ?? null,
      } : null,
      // The fitted scale, as a RECORDED fact of the run — the digest prints it
      // unconditionally, including when the news is good (a tight RMS). Absent
      // when nothing has been fitted, never invented as 1.
      scale: scaleFit ? {
        scale: scaleFit.scale ?? null,
        rms: scaleFit.rms ?? null,
        count: scaleFit.count ?? null,
        method: scaleFit.method ?? null,
        createdAt: scaleFit.createdAt ?? null,
        worstResidualM: Array.isArray(scaleFit.constraints) && scaleFit.constraints.length
          ? Math.max(...scaleFit.constraints.map((c) => Math.abs(c.residualM ?? 0)))
          : null,
      } : null,
    },
  }
}

// ── Renderers ──────────────────────────────────────────────────────────────────

function fmtNum(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '—'
  // Integers print bare; fractional values to `d` places.
  return Number.isInteger(v) ? String(v) : v.toFixed(d)
}

function fmtValue(value, unit) {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return '—'
  const n = typeof value === 'number' ? fmtNum(value) : String(value)
  return unit ? `${n} ${unit}` : n
}

// Bytes → a short human figure. Local (not core/dense/memBudget's formatBytes) to keep
// this module dependency-free — it is a pure formatter and nothing else.
function fmtBytes(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, n = v
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

function statusLine(status) {
  return `${status.ok} ok · ${status.warn} warn · ${status.bad} bad`
    + (status.missing ? ` · ${status.missing} n/a` : '')
}

// A JSON string — the precise, machine-parseable form. Whole digest verbatim.
export function digestToJson(digest) {
  return JSON.stringify(digest, null, 2)
}

// `key=value` for every non-null entry of a settings map, in declaration order.
// Nulls are dropped rather than printed as '—': in a *config* block "unknown" and
// "not applicable to this strategy" both mean "don't claim anything".
function kv(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v != null && v !== '')
    // Trailing zeros are noise in a settings echo (`ratioThreshold=0.75`, not `0.750`),
    // but the value must not be rounded away either — 4 places covers every knob.
    .map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(4) : v}`)
    .join(' · ')
}

// Share of images at the keypoint cap above which the digest flags it. Not an
// EVAL_THRESHOLDS entry: this is a run-shape note in a config echo, not a health tile.
// Matched to verdict.js KP_CAP_WARN_PCT so the two never disagree on screen.
const KP_CAP_NOTE_PCT = 90

// Track-filter gate ÷ observed p95 above which the gate is called inactive. Mirrors
// verdict.js GATE_HEADROOM_WARN for the same reason as KP_CAP_NOTE_PCT.
const GATE_HEADROOM_NOTE = 2

function configLines(config) {
  const out = []
  const { detect, match, sparse, dense } = config || {}
  if (detect) {
    const { detector, images, mixed, kpCapHitPct, ...rest } = detect
    out.push(`- **Detect**: ${detector ?? '?'}${images != null ? ` · ${images} image(s)` : ''}`
      + `${kv(rest) ? ` · ${kv(rest)}` : ''}`
      // Pulled out of `kv` because a bare `kpCapHitPct=100` reads as one more knob when
      // it is a finding: at 100% the cap, not contrastThreshold, chose the keypoints.
      + `${kpCapHitPct != null ? ` · ${fmtNum(kpCapHitPct, 0)}% of images at the keypoint cap`
        + `${kpCapHitPct >= KP_CAP_NOTE_PCT ? ' ⚠' : ''}` : ''}`
      // A per-image record means the batch can be heterogeneous; say so rather than
      // presenting one image's settings as the run's.
      + `${mixed ? ' · ⚠ settings differ between images' : ''}`)
  }
  if (match) {
    const { strategy, matcher, ...rest } = match
    out.push(`- **Match**: ${strategy ?? '?'} · ${matcher ?? '?'}${kv(rest) ? ` · ${kv(rest)}` : ''}`)
  }
  if (sparse) out.push(`- **Sparse**: ${kv(sparse)}`)
  if (dense) out.push(`- **Dense (Stage A)**: ${kv(dense)}`)
  return out
}

function diagnosticsLines(d) {
  const out = []
  if (!d) return out
  const {
    seed, attempts, gates, selfCal, intrinsics, selfCalDistortion,
    matchGates, timings, secondaryRecovery, fingerprints, trackCompletion, baSolver,
  } = d

  if (seed) {
    const ru = seed.runnerUp
    out.push(`- **Seed**: ${seed.nameA} ↔ ${seed.nameB} — ${fmtNum(seed.angleDeg)}° parallax, `
      + `${fmtNum(seed.inliers)} inliers, ${fmtNum(seed.points)} pts`
      + `${seed.score != null ? `, score ${fmtNum(seed.score, 1)}` : ''}`
      + `${seed.degree != null ? `, degree ${seed.degree}` : ''}`
      + `${seed.readyViews != null ? `, ${seed.readyViews} PnP-ready views` : ''}`
      + `${seed.candidatesScored != null ? ` (of ${seed.candidatesScored} scored)` : ''}`)
    if (ru) out.push(`  runner-up: ${ru.pair} at score ${fmtNum(ru.score, 1)}`)
  }
  if (attempts) {
    // "Was a retry needed" is the SB acceptance criterion, so it is stated even when
    // the answer is no — an absent line would be ambiguous with an absent record.
    // 1-based for the reader; the record is 0-based (attempt 0 = the first seed).
    out.push(`- **Seed attempts**: ${attempts.retriesRun ?? 0} retry(ies) of ${attempts.retryCap ?? 0} cap`
      + `, kept attempt ${(attempts.winner ?? 0) + 1}`
      + `${(attempts.retriesRun ?? 0) === 0 ? ' (first seed, no retry)' : ''}`)
    for (const s of attempts.seeds || []) {
      out.push(`  attempt ${s.attempt + 1}: ${s.pair ?? '(failed)'} → ${s.cameras} cams / ${s.points} pts`
        + `${s.kept ? ' ← kept' : ''}`)
    }
  }
  if (gates) {
    // Headroom = the track-filter gate over the observed p95. Above ~2× the gate sits
    // past essentially every residual, so the filter removed nothing and a reprojection
    // tail survives by construction rather than because the geometry is bad.
    const obs = gates.observedP95px
    const filt = gates.filterMaxReprojPx
    const headroom = obs != null && obs > 0 && filt != null ? filt / obs : null
    out.push(`- **Reprojection gates**: ×${fmtNum(gates.detectScaleFactor)} `
      + `(median detection scale ${gates.medianScale != null ? fmtNum(gates.medianScale, 3) : 'inherited'})`
      + ` → PnP/BA ${fmtNum(gates.reprjThresholdPx)}px, track filter ${fmtNum(gates.filterMaxReprojPx)}px`
      + `${gates.clamped ? ' · ⚠ clamped' : ''}${gates.mixed ? ' · ⚠ mixed scales' : ''}`)
    if (headroom != null) {
      out.push(`  vs observed p95 ${fmtNum(obs)}px → ${fmtNum(headroom, 1)}× headroom`
        + `${headroom >= GATE_HEADROOM_NOTE ? ' ⚠ the track filter is effectively inactive' : ''}`)
    }
  }
  if (matchGates) {
    const { degenerate: dg, degenerateOf: dgOf } = matchGates
    out.push(`- **Match gates**: ${matchGates.pairs} pairs → ${matchGates.accepted} accepted, `
      + `${matchGates.weak} weak, ${matchGates.rejected} rejected, ${matchGates.skipped} skipped, `
      + `${matchGates.gated} subset-gated (gate ${matchGates.subsetGateActive ? 'on' : 'off'})`
      + `; mean inlier ratio ${fmtNum(matchGates.meanInlierRatio)}`
      + `${matchGates.resolvedRansacPx != null ? `, RANSAC ${fmtNum(matchGates.resolvedRansacPx)}px` : ''}`)
    // H/F degeneracy share over the accepted pairs: how much of the graph is planar or
    // rotation-dominated, where F is not uniquely determined. Printed whenever a run
    // recorded it, including 0.
    if (dg != null && dgOf) {
      out.push(`  H/F-degenerate (planar / pure rotation): ${dg}/${dgOf} accepted `
        + `(${fmtNum((100 * dg) / dgOf, 0)}%)`)
    }
  }
  if (selfCal) {
    out.push(`- **Self-cal**: requested '${selfCal.requested}' → '${selfCal.resolved}'`
      + `${selfCal.staged ? ' (staged)' : ''}`)
    for (const p of selfCal.passes || []) {
      out.push(`  pass ${p.pass}: '${p.mode}'${p.reducedReason ? ` — reduced: ${p.reducedReason}` : ''}`)
    }
    for (const a of selfCal.adjustments || []) {
      const rejected = (a.sensors || []).filter((s) => !s.accepted)
      if (rejected.length) {
        out.push(`  ⚠ ${a.label}: rejected before commit — ${rejected.map((s) => s.rejectionReason).join('; ')}`)
      }
    }
  }
  for (const r of intrinsics || []) {
    // The fx trajectory is the single most diagnostic number on an EXIF-only or film
    // set: the same start value reaches 2566 on a good run and 4796 on a runaway.
    out.push(`- **fx** ${r.label ?? r.sensorId ?? 'sensor'}: ${fmtNum(r.fxNominal, 1)} → ${fmtNum(r.fxFinal, 1)}`
      + `${r.deltaPct != null ? ` (${r.deltaPct >= 0 ? '+' : ''}${fmtNum(r.deltaPct, 1)}%)` : ''}`
      + `${r.source ? ` · ${r.source}` : ''}`)
  }
  for (const r of selfCalDistortion || []) {
    out.push(`  composed radial: k1 ${fmtNum(r.k1, 5)}, k2 ${fmtNum(r.k2, 5)}, k3 ${fmtNum(r.k3, 5)}`
      + ` (fit RMS ${fmtNum(r.fitRmsPx, 3)}px)`)
  }
  if (trackCompletion?.length) {
    const sum = (k) => trackCompletion.reduce((s, r) => s + (r[k] ?? 0), 0)
    out.push(`- **Track completion** (final stage): +${fmtNum(sum('added'))} obs via verified pairs`
      + `, ${fmtNum(sum('lifted'))} point(s) lifted to ≥3 views over ${trackCompletion.length} pass(es)`)
    for (const r of trackCompletion) {
      out.push(`  ${r.stage}: +${r.added} in ${r.rounds} round(s), lifted ${r.lifted}`
        + ` (2-view ${r.before?.t2} → ${r.after?.t2})`)
    }
  }
  if (secondaryRecovery) {
    out.push(`- **Secondary recovery**: ${secondaryRecovery.jobs ?? 0} job(s), `
      + `${secondaryRecovery.merged?.length ?? 0} merged, ${secondaryRecovery.separate?.length ?? 0} kept separate`)
    for (const m of secondaryRecovery.separate || []) {
      out.push(`  ${m.name}: ${m.cameras} cams / ${m.points} pts, ${m.sharedCameras} shared — ${m.reason}`)
    }
  }
  if (fingerprints) {
    out.push(`- **Run fingerprints**: features ${fingerprints.features ?? '—'} · matches ${fingerprints.matches ?? '—'}`)
  }
  if (timings) {
    const parts = Object.entries(timings)
      .filter(([k]) => k !== 'totalMs')
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
    out.push(`- **Sparse timings**: total ${((timings.totalMs ?? 0) / 1000).toFixed(1)}s`
      + `${parts.length ? ` — ${parts.join(', ')}` : ''}`)
  }
  if (baSolver?.calls) {
    const b = baSolver
    const policy = Object.entries(b.policy ?? {}).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`)
    out.push(`- **BA solver**: ${b.calls} calls, ${((b.ms ?? 0) / 1000).toFixed(1)}s, largest n ${b.maxN}; `
      + `${b.solves} solves — ${b.cholesky} Cholesky, PCG ${b.pcgConverged} converged / ${b.pcgPartial} partial / `
      + `${b.pcgFallback} → Cholesky (${b.pcgIters} CG it, max ${b.pcgItersMax}); `
      + `policy ${policy.length ? policy.join(', ') : 'default'}`)
  }
  return out
}

// A compact markdown string — the human/LLM-readable form.
export function digestToMarkdown(digest) {
  const L = []
  L.push(`# websfm project summary — ${digest.project}`)
  L.push(`${digest.date} · CRS unit: ${digest.crsUnit}`)
  L.push(`STATUS: **${digest.status.overall}** — ${statusLine(digest.status)}`)
  L.push('')

  // Verdict first: it is the one section that says what to DO about the numbers.
  if (digest.verdict) {
    L.push(`## Verdict — ${digest.verdict.level ?? '—'}`)
    if (digest.verdict.headline) L.push(digest.verdict.headline)
    for (const f of digest.verdict.findings) {
      L.push(`- [${f.level}] ${f.title}${f.fix ? ` → ${f.fix}` : ''}`)
    }
    L.push('')
  }

  // Run config — what produced these numbers. Omitted entirely when nothing is known,
  // so a digest never implies settings it cannot vouch for.
  const cfgLines = configLines(digest.config)
  if (cfgLines.length) {
    L.push('## Run config')
    L.push(...cfgLines)
    L.push('')
  }

  // Health, grouped by section.
  L.push('## Health')
  for (const grp of digest.health) {
    L.push(`### ${cap(grp.section)}`)
    for (const r of grp.rows) {
      const tag = `[${r.status}]`.padEnd(9)
      const hint = r.hint ? `  (${r.hint})` : ''
      L.push(`- ${tag} ${r.label}: ${fmtValue(r.value, r.unit)}${hint}`)
    }
  }
  L.push('')

  // Top offenders.
  const { residuals, unregistered } = digest.offenders
  if (residuals.length || unregistered.length) {
    L.push('## Top offenders')
    if (residuals.length) {
      L.push('Highest reprojection RMS:')
      for (const r of residuals) {
        const obs = r.nObs != null ? `  (${r.nObs} obs)` : ''
        L.push(`- ${r.name}: ${fmtNum(r.rmsPx)} px${obs}`)
      }
    }
    if (unregistered.length) {
      L.push('Unregistered images:')
      for (const r of unregistered) L.push(`- ${r.name}: ${r.reason}`)
    }
    L.push('')
  }

  // Run details.
  const { sparse, dense, depth, scale } = digest.run
  if (sparse || dense || depth || scale) {
    L.push('## Run details')
    if (sparse) {
      L.push(`Sparse: cameras ${fmtNum(sparse.cameras)}, points ${fmtNum(sparse.points)}, `
        + `≥3-view ${fmtNum(sparse.pct3plusViewTracks)}%, `
        + `pre-BA P95 ${fmtNum(sparse.preBaP95px)} px, `
        + `post-BA median ${fmtNum(sparse.postBaMedianPx)} px`)
    }
    if (depth) {
      L.push(`Depth maps (Stage A): ${fmtNum(depth.maps)} map(s) on ${depth.backend ?? '?'}`
        + `${depth.gpuFallbacks ? ` (${depth.gpuFallbacks} GPU fallback(s))` : ''}`
        + `, median ${((depth.medianMsPerImage ?? 0) / 1000).toFixed(1)}s/image`
        + `, total ${((depth.totalMs ?? 0) / 1000).toFixed(1)}s`
        + `; median coverage ${fmtNum(depth.medianCoveragePct, 1)}%`
        + `, median cost ${fmtNum(depth.medianCostMedian)}`)
      // The cross-view filter's cost vs its bite — TODO ▸ DF asks for exactly this pair.
      if (depth.geomFilterMs != null) {
        L.push(`Cross-view filter: ${(depth.geomFilterMs / 1000).toFixed(1)}s`
          + `, median kept ${fmtNum(depth.geomFilterMedianKeptPct, 1)}%`
          + `, min kept ${fmtNum(depth.geomFilterMinKeptPct, 1)}%`
          + `, ${fmtNum(depth.geomFilterMarginalMaps)} marginal map(s) (<1%)`)
      }
      if (depth.projectedPeakBytes != null) {
        L.push(`Memory: projected peak ${fmtBytes(depth.projectedPeakBytes)}`
          + ` vs budget ${fmtBytes(depth.budgetBytes)}`)
      }
    }
    if (dense) {
      const cull = dense.cullBreakdown
        ? Object.entries(dense.cullBreakdown).map(([k, v]) =>
          `${k}=${typeof v === 'number' ? fmtNum(v, 1) : v}`).join(', ')
        : '—'
      L.push(`Dense (Stage B): cost median ${fmtNum(dense.costMedian)}, `
        + `kept ${fmtNum(dense.keptPct)}%`
        + `${dense.mergeCell != null ? `, merge cell ${fmtNum(dense.mergeCell, 4)}` : ''}`
        + `, culls {${cull}}`)
    }
    if (scale) {
      L.push(`Scale: ${fmtNum(scale.scale, 6)} m per model unit from ${fmtNum(scale.count)} `
        + `${scale.method ?? 'constraint'} bar(s), RMS ${fmtNum(scale.rms, 4)} m`
        + (scale.worstResidualM != null ? `, worst residual ${fmtNum(scale.worstResidualM, 4)} m` : ''))
    }
    L.push('')
  }

  // Diagnostics last: longest section, and the one a reader only reaches when a
  // number above needs explaining.
  const diag = diagnosticsLines(digest.diagnostics)
  if (diag.length) {
    L.push('## Diagnostics')
    L.push(...diag)
    L.push('')
  }

  return L.join('\n').replace(/\n+$/, '\n')
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }
