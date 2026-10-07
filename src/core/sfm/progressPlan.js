// Phase-weighted progress for the sparse SfM run.
//
// The bar used to be driven by the registered-camera count, which is not a measure
// of the run's progress: registration is roughly half the work, so the bar reached
// 100% while bundle adjustment, retriangulation, track filtering and GCP anchoring
// were still to come — and then sat there. Worse, a run is not one pass: alternate
// seed retries and each stranded-component secondary model re-run the whole
// single-model pipeline, driving that same counter 0→100% again, several times.
//
// So progress is expressed as a weighted walk over named phases, and nested sub-runs
// are remapped into a slice of the parent's range. The result is a single monotonic
// 0..1 for the whole run, whatever shape it takes. `done`/`total` still ride along
// as the numeric readout; they are no longer the bar.
//
// Weights are a rough share of wall-clock on a typical set, not a measurement — they
// only need to be good enough that the bar does not stall or sprint. Registration
// dominates; the post-filter passes are what the old bar hid entirely.
export const SFM_PHASES = [
  { key: 'initPair',       weight: 0.10, label: 'Choosing initial pair' },
  { key: 'register',       weight: 0.45, label: 'Registering images' },
  { key: 'bundle',         weight: 0.15, label: 'Bundle adjustment' },
  { key: 'retriangulate',  weight: 0.08, label: 'Retriangulating' },
  { key: 'trackFilter',    weight: 0.12, label: 'Filtering tracks' },
  { key: 'gcpBundle',      weight: 0.05, label: 'Position-constrained bundle adjustment' },
  { key: 'finalize',       weight: 0.05, label: 'Finalising' },
]

// Cumulative start offset of each phase, normalised so the weights sum to 1 even if
// the table is edited without re-balancing.
export function phaseOffsets(phases = SFM_PHASES) {
  const total = phases.reduce((s, p) => s + p.weight, 0) || 1
  const out = new Map()
  let acc = 0
  for (const p of phases) {
    out.set(p.key, { start: acc / total, span: p.weight / total, label: p.label })
    acc += p.weight
  }
  return out
}

/**
 * Build the reporter the SfM run calls instead of `onProgress` directly.
 *
 * `report(phaseKey, local, label, counts)` — `local` is 0..1 progress *within* the
 * phase (clamped), `counts` an optional `{ done, total }` for the numeric readout.
 * Emits `onProgress(done, total, label, globalFraction)`.
 *
 * `start`/`end` carve out this run's slice of the overall bar, which is what lets a
 * secondary model report its own honest 0..1 without touching the parent's range.
 */
export function makeProgressReporter(onProgress, { start = 0, end = 1, phases = SFM_PHASES } = {}) {
  if (!onProgress) return () => {}
  const offsets = phaseOffsets(phases)
  const span = Math.max(0, end - start)
  return function report(phaseKey, local = 0, label, counts = {}) {
    const ph = offsets.get(phaseKey)
    if (!ph) return
    const clamped = Math.min(1, Math.max(0, local))
    const fraction = start + span * (ph.start + ph.span * clamped)
    onProgress(counts.done ?? 0, counts.total ?? 0, label ?? ph.label, fraction)
  }
}

/**
 * Remap a child run's global 0..1 into `[start, end]` of the parent's bar. Used for
 * alternate-seed retries and secondary models, which each run the full single-model
 * pipeline and would otherwise restart the bar from zero.
 *
 * `decorate` prefixes the child's label so the user can see which sub-run is talking.
 */
export function scopeProgress(onProgress, { start, end, decorate } = {}) {
  if (!onProgress) return undefined
  const span = Math.max(0, end - start)
  return (done, total, label, fraction) => {
    // A child that reports no fraction (an older/plain hook) contributes only its
    // label — better a stalled-but-honest bar than one that jumps to the slice end.
    const local = fraction == null ? null : Math.min(1, Math.max(0, fraction))
    const text = decorate ? decorate(label) : label
    onProgress(done, total, text, local == null ? undefined : start + span * local)
  }
}

// Range budget for the whole `reconstruct()` orchestration. The primary model owns
// the bulk; retries and secondaries share the tail, subdivided as they are discovered
// (their count is not known until the primary finishes). The last sliver is the merge
// and summary work after the final sub-run.
export const RUN_BUDGET = {
  primary:   [0, 0.75],
  recovery:  [0.75, 0.97],
  finalize:  [0.97, 1],
}

// Split `[start, end]` into `n` equal consecutive slices.
export function sliceRange([start, end], n, i) {
  if (!(n > 0)) return [start, end]
  const step = (end - start) / n
  return [start + step * i, start + step * (i + 1)]
}
