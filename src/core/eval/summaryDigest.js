// Compact, copy-pasteable project digest (PLAN-debug-summary). A second *view* of
// the same numbers the Quality Report hub shows — it consumes the already-classified
// `projectHealth` rows plus the raw snapshot, so it can never disagree with the hub
// (see composables/useQualityReport.js). Pure: no Vue/DOM/store imports, plain data in,
// a structured digest object out, rendered to markdown OR JSON by the two renderers.
//
// The motivating use: a large run's log is too long to skim for "did this succeed?",
// so the user copies this ~30-50 line digest instead. Markdown for reading, JSON for
// precise machine parsing — same content, the modal lets the user pick.

// Input:
//   {
//     projectName, date, crsUnit,
//     rows:      projectHealth() output [{ id, section, label, value, unit, status, hint }],
//     snapshot:  the plain health snapshot (raw figures behind the rows),
//     offenders: { residuals:[{ name, nObs, rmsPx }], unregistered:[{ name, reason }] },
//     summary:      recon.summary    | null   (sparse run figures),
//     denseSummary: recon.denseSummary | null (dense run figures),
//   }
// → digest: { project, date, crsUnit, status, health, offenders, run }
export function buildProjectDigest(input = {}) {
  const {
    projectName = 'untitled',
    date = new Date().toISOString(),
    crsUnit = 'm',
    rows = [],
    offenders = {},
    summary = null,
    denseSummary = null,
  } = input

  // Status roll-up across the classified health rows.
  const status = { ok: 0, warn: 0, bad: 0, missing: 0 }
  for (const r of rows) {
    if (r.status in status) status[r.status]++
  }
  // A single word for the whole project: the worst present tone wins.
  status.overall = status.bad ? 'bad' : status.warn ? 'warn' : status.ok ? 'ok' : 'unknown'

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
    health,
    offenders: {
      residuals: (offenders.residuals || []).map((r) => ({
        name: r.name, nObs: r.nObs ?? null, rmsPx: r.rmsPx ?? null,
      })),
      unregistered: (offenders.unregistered || []).map((r) => ({
        name: r.name, reason: r.reason || 'unknown',
      })),
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
        cullBreakdown: denseSummary.cullBreakdown ?? null,
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

function statusLine(status) {
  return `${status.ok} ok · ${status.warn} warn · ${status.bad} bad`
    + (status.missing ? ` · ${status.missing} n/a` : '')
}

// A JSON string — the precise, machine-parseable form. Whole digest verbatim.
export function digestToJson(digest) {
  return JSON.stringify(digest, null, 2)
}

// A compact markdown string — the human/LLM-readable form.
export function digestToMarkdown(digest) {
  const L = []
  L.push(`# websfm project summary — ${digest.project}`)
  L.push(`${digest.date} · CRS unit: ${digest.crsUnit}`)
  L.push(`STATUS: **${digest.status.overall}** — ${statusLine(digest.status)}`)
  L.push('')

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
  const { sparse, dense } = digest.run
  if (sparse || dense) {
    L.push('## Run details')
    if (sparse) {
      L.push(`Sparse: cameras ${fmtNum(sparse.cameras)}, points ${fmtNum(sparse.points)}, `
        + `≥3-view ${fmtNum(sparse.pct3plusViewTracks)}%, `
        + `pre-BA P95 ${fmtNum(sparse.preBaP95px)} px, `
        + `post-BA median ${fmtNum(sparse.postBaMedianPx)} px`)
    }
    if (dense) {
      const cull = dense.cullBreakdown
        ? Object.entries(dense.cullBreakdown).map(([k, v]) => `${k}=${v}`).join(', ')
        : '—'
      L.push(`Dense: cost median ${fmtNum(dense.costMedian)}, `
        + `kept ${fmtNum(dense.keptPct)}%, culls {${cull}}`)
    }
    L.push('')
  }

  return L.join('\n').replace(/\n+$/, '\n')
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }
