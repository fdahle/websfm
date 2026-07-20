// Pure quality-report HTML assembler (PLAN-eval-quality-hub WS6 / TODO F8). Takes a
// plain report object — assembled by the store from the SAME snapshot + pure eval
// fns the Quality Report hub renders, so the exported document and the hub can't
// drift — and returns ONE self-contained HTML string: inline CSS, no external assets,
// no scripts. The user prints it to PDF from the browser. No Vue/Pinia/DOM.
//
// report: {
//   projectName, date (ISO string), crsUnit,
//   health: [{ label, value, unit, status, hint }],   // projectHealth rows
//   sections: [{
//     title,
//     tiles?:   [{ label, value, unit, tone, hint }],
//     columns?: [{ key, label, align }],
//     rows?:    [ { <key>: string|number } ],          // pre-formatted cells
//     note?: string,
//   }],
// }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

const STATUS_LABEL = { ok: 'OK', warn: 'Warn', bad: 'Bad', missing: 'n/a' }

function healthTable(rows) {
  if (!rows?.length) return ''
  const body = rows.map((r) => `
    <tr class="st-${esc(r.status)}">
      <td><span class="dot"></span>${esc(r.label)}</td>
      <td class="num">${r.value == null ? '—' : esc(r.value)}${r.unit ? ' ' + esc(r.unit) : ''}</td>
      <td class="tag">${esc(STATUS_LABEL[r.status] ?? r.status)}</td>
      <td class="hint">${esc(r.hint || '')}</td>
    </tr>`).join('')
  return `<table class="health"><thead><tr>
    <th>Metric</th><th class="num">Value</th><th>Status</th><th>Note</th>
  </tr></thead><tbody>${body}</tbody></table>`
}

function tiles(list) {
  if (!list?.length) return ''
  const cells = list.map((t) => `
    <div class="tile tone-${esc(t.tone || 'none')}">
      <div class="tv">${esc(t.value)}${t.unit ? `<span class="tu"> ${esc(t.unit)}</span>` : ''}</div>
      <div class="tl">${esc(t.label)}</div>
      ${t.hint ? `<div class="th">${esc(t.hint)}</div>` : ''}
    </div>`).join('')
  return `<div class="tiles">${cells}</div>`
}

function dataTable(columns, rows) {
  if (!columns?.length || !rows?.length) return ''
  const head = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${esc(c.label)}</th>`).join('')
  const body = rows.map((row) => `<tr>${
    columns.map((c) => `<td class="${c.align === 'right' ? 'num' : ''}">${esc(row[c.key] ?? '—')}</td>`).join('')
  }</tr>`).join('')
  return `<table class="dt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

function section(s) {
  return `<section>
    <h2>${esc(s.title)}</h2>
    ${tiles(s.tiles)}
    ${dataTable(s.columns, s.rows)}
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
  </section>`
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; color: #1a1a1a;
    background: #fff; margin: 0; padding: 32px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  .sub { color: #666; font-size: 12px; margin: 0 0 24px; }
  h2 { font-size: 15px; margin: 28px 0 10px; padding-bottom: 5px; border-bottom: 1px solid #e2e2e2; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  th, td { text-align: left; padding: 6px 9px; border-bottom: 1px solid #ececec; font-variant-numeric: tabular-nums; }
  th { color: #666; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  .num { text-align: right; }
  .health .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: #bbb; vertical-align: middle; }
  .health .st-ok   .dot { background: #2e9e5b; }
  .health .st-warn .dot { background: #e6a01e; }
  .health .st-bad  .dot { background: #e0533d; }
  .health .tag { font-size: 11px; color: #666; }
  .health .st-warn .tag { color: #b9791a; }
  .health .st-bad  .tag { color: #c23a26; }
  .health .hint { color: #888; font-size: 11px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 8px 0; }
  .tile { border: 1px solid #e2e2e2; border-radius: 6px; padding: 9px 11px; }
  .tv { font-size: 18px; font-weight: 600; } .tu { font-size: 12px; font-weight: 400; color: #888; }
  .tl { font-size: 11px; color: #666; margin-top: 2px; } .th { font-size: 10px; color: #999; margin-top: 3px; }
  .tone-ok .tv { color: #2e9e5b; } .tone-warn .tv { color: #b9791a; } .tone-bad .tv { color: #c23a26; }
  .note { color: #777; font-size: 11px; margin: 4px 0 0; }
  @media print { body { padding: 0; } h2 { break-after: avoid; } section { break-inside: avoid; } }
`

export function buildReportHtml(report = {}) {
  const name = report.projectName || 'Project'
  const date = report.date ? new Date(report.date) : new Date()
  const sections = (report.sections || []).map(section).join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)} — Quality Report</title>
<style>${STYLE}</style></head>
<body>
  <h1>${esc(name)} — Quality Report</h1>
  <p class="sub">Generated ${esc(date.toLocaleString())} · websfm</p>
  <section><h2>Overview</h2>${healthTable(report.health)}</section>
  ${sections}
</body></html>`
}
