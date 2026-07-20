// Pure run-to-run summary diff for the Quality Report ▸ run comparison
// (PLAN-eval-quality-hub WS5). "Did that settings tweak help?" — compares two run
// summaries metric-by-metric. History is summaries only (cheap JSON); no cloud
// diffing. No Vue/Pinia/DOM.

// Which summary fields to compare, and which direction is "better". `higher` = a
// larger value is an improvement (more registered, more points, more multi-view
// tracks); otherwise smaller is better (reprojection error).
const METRICS = [
  { key: 'nCameras',           label: 'Registered',      dir: 'higher', digits: 0 },
  { key: 'nPoints',            label: 'Points',          dir: 'higher', digits: 0 },
  { key: 'pct3plusViewTracks', label: '≥3-view tracks',  dir: 'higher', digits: 1, unit: '%' },
  { key: 'postBaMedianPx',     label: 'Post-BA median',  dir: 'lower',  digits: 2, unit: 'px' },
  { key: 'preBaP95px',         label: 'Pre-BA P95',      dir: 'lower',  digits: 2, unit: 'px' },
]

// diffSummaries(cur, prev) → [{ key, label, cur, prev, delta, dir, verdict, unit,
// digits }]. verdict ∈ 'better'|'worse'|'same'. Rows whose metric is absent from
// BOTH summaries are dropped; a value present in only one shows delta null. `prev`
// null (no history) → every row's verdict 'same' with prev null.
export function diffSummaries(cur, prev) {
  const out = []
  for (const m of METRICS) {
    const c = cur?.[m.key]
    const p = prev?.[m.key]
    if (c == null && p == null) continue
    let delta = null
    let verdict = 'same'
    if (c != null && p != null) {
      delta = c - p
      const eps = Math.abs(p) * 1e-6 + 1e-9
      if (Math.abs(delta) <= eps) verdict = 'same'
      else if (m.dir === 'higher') verdict = delta > 0 ? 'better' : 'worse'
      else verdict = delta < 0 ? 'better' : 'worse'
    }
    out.push({
      key: m.key, label: m.label, cur: c ?? null, prev: p ?? null,
      delta, dir: m.dir, verdict, unit: m.unit || '', digits: m.digits,
    })
  }
  return out
}
