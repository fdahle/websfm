// The tables of docs/BENCHMARKS.md, written from docs/benchmarks.json (the scores of the
// published run, suites/publish.mjs). Pure: data in, markdown out, so a unit test can hold
// BENCHMARKS.md to the data without the bench disk.
//
// In BENCHMARKS.md a generated table sits between `<!-- table:<id> -->` and `<!-- /table -->`;
// everything outside the markers is written by hand. Cells use the scoreboard's own
// formatting (suites/scoreboard.mjs COLUMNS), so the page and the scoreboard agree.

import { COLUMNS, SCALE } from '../suites/scoreboard.mjs'

const DASH = '–'
const nf = (v) => Math.round(v).toLocaleString('en-US')
const bold = (s, on) => (on && s !== DASH ? `**${s}**` : s)
const k = (job) => SCALE[job.unit] ?? 1
const all = (x) => x?.cameras && x.cameras[0] === x.cameras[1]
// "· 2 of 5 runs failed" after a cell whose job had failed runs (aggregateRuns).
const failNote = (j) => (j.failed?.length ? ` · ${j.failed.length} of ${j.runs} runs failed` : '')

// One row per block, one column per tool; `cell` formats a job, `score` ranks it (lower is
// better unless `higher`), the best of a row in bold.
function wide(jobs, { first, cell, score, higher = false, extra = [], missing = () => DASH }) {
  const tools = [...new Set(jobs.map((j) => j.label))]
  const blocks = [...new Set(jobs.map((j) => j.block))]
  const lines = [`| ${[first, ...tools, ...extra.map((e) => e.head)].join(' | ')} |`]
  lines.push(`| ${[first, ...tools, ...extra].map(() => '---').join(' | ')} |`)
  for (const b of blocks) {
    const row = jobs.filter((j) => j.block === b)
    const of = (t) => row.find((j) => j.label === t)
    const scores = tools.map((t) => (of(t)?.score ? score(of(t)) : null)).filter((v) => v != null)
    const best = scores.length > 1 ? (higher ? Math.max(...scores) : Math.min(...scores)) : null
    const cells = tools.map((t) => {
      const j = of(t)
      if (!j) return missing(b, t)
      if (!j.score) return 'not run'
      return bold(cell(j), best != null && score(j) === best)
    })
    lines.push(`| ${[b, ...cells, ...extra.map((e) => e.cell(row, tools))].join(' | ')} |`)
  }
  return lines
}

// One row per block and tool, one column per measure.
function long(jobs, cols) {
  const lines = [
    `| block | run | ${cols.map((c) => c.head).join(' | ')} |`,
    `| ${['', '', ...cols].map(() => '---').join(' | ')} |`,
  ]
  let last = null
  for (const j of jobs) {
    const block = j.block === last ? '' : j.block
    last = j.block
    const cells = cols.map((c) => (j.score ? c.cell(j) : 'not run'))
    lines.push(`| ${block} | ${j.label} | ${cells.join(' | ')} |`)
  }
  return lines
}

const col = (name, head) => ({ head, cell: (j) => COLUMNS[name].cell(j.score, k(j)) })
const time = (pick = (x) => x.sfmSeconds) => ({
  head: 'SfM time (s)',
  cell: (j) => (pick(j.score) ? nf(pick(j.score)) : DASH),
})
const seconds = (row, tools, pick) =>
  tools
    .map((t) => row.find((j) => j.label === t)?.score)
    .map((x) => (x && pick(x) ? nf(pick(x)) : DASH))
    .join(' · ')

// The tables, by the id BENCHMARKS.md's markers name.
export const TABLES = {
  'eth3d-sparse': (d) =>
    wide(d.byTable['eth3d-sparse'], {
      first: 'scene',
      cell: (j) => COLUMNS.truth.cell(j.score, k(j)) + failNote(j),
      score: (j) => j.score.truth?.median ?? null,
      // South Building is scored against COLMAP's own model of it.
      missing: (b, t) => (b === 'South Building' && t === 'COLMAP' ? 'reference' : DASH),
      extra: [{ head: 'SfM time, s (in tool order)', cell: (row, tools) => seconds(row, tools, (x) => x.sfmSeconds) }],
    }),
  'eth3d-dense': (d) => {
    const jobs = d.byTable['eth3d-dense']
    const f1 = (j) => j.score.denseOfficial?.f1 ?? null
    const lines = wide(jobs, {
      first: 'scene',
      cell: (j) => `${f1(j)?.toFixed(1) ?? DASH} · ${j.score.denseSeconds ? nf(j.score.denseSeconds) : DASH} s`,
      score: f1,
      higher: true,
    })
    const tools = [...new Set(jobs.map((j) => j.label))]
    const mean = tools.map((t) => {
      const js = jobs.filter((j) => j.label === t && j.score)
      const m = js.reduce((a, j) => a + f1(j), 0) / js.length
      const s = js.reduce((a, j) => a + (j.score.denseSeconds ?? 0), 0)
      return `${m.toFixed(1)} · ${nf(s)} s`
    })
    lines.push(`| **mean / total** | ${mean.join(' | ')} |`)
    return lines
  },
  'drone-free': (d) =>
    wide(d.byTable['drone-free'], {
      first: 'block',
      cell: (j) => COLUMNS.position.cell(j.score, k(j)) + (all(j.score) ? '' : ` (${j.score.cameras.join('/')})`),
      score: (j) => (j.score.position ? Math.hypot(j.score.position.h, j.score.position.v) : null),
    }),
  'drone-free-time': (d) =>
    wide(d.byTable['drone-free'], {
      first: 'block',
      cell: (j) => (j.score.sfmSeconds ? nf(j.score.sfmSeconds) : DASH),
      score: (j) => j.score.sfmSeconds ?? null,
    }),
  'drone-rtk': (d) =>
    long(d.byTable['drone-rtk'], [
      col('checkpoints', 'checkpoints (cm)'),
      col('meanHeight', 'mean height error (cm)'),
      col('position', 'cameras vs RTK (cm)'),
      time(),
    ]),
  'film-cg': (d) => film(d.byTable.film.filter((j) => j.block.startsWith('Casa Grande'))),
  'film-il': (d) => film(d.byTable.film.filter((j) => j.block.startsWith('Iceland'))),
  'strecha': (d) =>
    wide(d.byTable.strecha, {
      first: 'set',
      cell: (j) => COLUMNS.truth.cell(j.score, k(j)) + failNote(j),
      score: (j) => j.score.truth?.median ?? null,
      extra: [{ head: 'SfM time, s (in tool order)', cell: (row, tools) => seconds(row, tools, (x) => x.sfmSeconds) }],
    }),
  'film-heldout': (d) => film(d.byTable['film-heldout']),
  'drone-heldout': (d) =>
    long(d.byTable['drone-heldout'], [
      col('cameras', 'cameras'),
      col('checkpoints', 'checkpoints (cm)'),
      col('meanHeight', 'mean height error (cm)'),
      time(),
    ]),
  'pipeline': (d) => pipeline(d.byTable.pipeline),
  'lidar': (d) =>
    long(
      d.byTable.pipeline.filter((j) => j.score?.lidar),
      [
        col('densePoints', 'dense points'),
        col('lidar', 'median / within 10 cm'),
        col('lidarDome', 'without the bowl'),
        col('bowl', 'bowl at the edge (m)'),
      ],
    ),
  'mill19': (d) =>
    long(d.byTable.mill19, [
      col('cameras', 'cameras'),
      col('position', 'cameras vs reference (m)'),
      col('pipeTotal', 'total (s)'),
      col('pipeSfm', 'import + SfM'),
      col('pipeDense', 'depth + dense'),
      col('pipeDsmOrtho', 'DSM + ortho'),
      col('pipeMesh', 'mesh'),
      col('peak', 'peak (GiB)'),
      col('densePoints', 'dense points'),
    ]),
}

// The full pipeline: one row per block and tool, the fastest total and the smallest peak
// memory of a block in bold.
function pipeline(jobs) {
  const cols = ['pipeTotal', 'pipeSfm', 'pipeDense', 'pipeMesh', 'pipeTexture', 'pipeDsmOrtho', 'peak', 'densePoints']
  const heads = ['total', 'import + SfM', 'depth + dense', 'mesh', 'texture', 'DSM + ortho', 'peak', 'dense points']
  const best = (b, key) => {
    const v = jobs.filter((j) => j.block === b && j.score?.pipe?.[key] != null).map((j) => j.score.pipe[key])
    return v.length > 1 ? Math.min(...v) : null
  }
  const lines = [`| block | tool | ${heads.join(' | ')} |`, `| ${['', '', ...heads].map(() => '---').join(' | ')} |`]
  let last = null
  for (const j of jobs) {
    const block = j.block === last ? '' : j.block
    last = j.block
    const p = j.score?.pipe
    const cells = cols.map((c) => {
      if (!p) return 'not run'
      const s = COLUMNS[c].cell(j.score, k(j))
      if (c === 'pipeTotal') return bold(s, p.total === best(j.block, 'total'))
      if (c === 'peak')
        return bold(s, p.peakGB != null && Math.round(p.peakGB) === Math.round(best(j.block, 'peakGB') ?? NaN))
      return s
    })
    lines.push(`| ${block} | ${j.label} | ${cells.join(' | ')} |`)
  }
  return lines
}

function film(jobs) {
  return long(jobs, [
    col('cameras', 'cameras'),
    col('checkpoints', 'checkpoints (m)'),
    col('dem', 'DEM vs reference RMSE / NMAD (m)'),
    col('coverage', 'DEM coverage'),
  ])
}

/** The data with its jobs grouped by table. */
export function indexed(data) {
  const byTable = {}
  for (const j of data.jobs) (byTable[j.table] ??= []).push(j)
  return { ...data, byTable }
}

const MARK = /<!-- table:([a-z0-9-]+) -->\n[\s\S]*?<!-- \/table -->/g

/** BENCHMARKS.md with every marked table written from the data. Throws on an unknown id. */
export function withTables(md, data) {
  const d = indexed(data)
  return md.replace(MARK, (_, id) => {
    const make = TABLES[id]
    if (!make) throw new Error(`BENCHMARKS.md names a table "${id}" that bench-tables.mjs does not make`)
    return `<!-- table:${id} -->\n${make(d).join('\n')}\n<!-- /table -->`
  })
}
