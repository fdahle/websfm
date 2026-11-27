// The README's results table, made from the tables of docs/BENCHMARKS.md so the two
// cannot disagree: every number below is read out of a BENCHMARKS table cell (or
// computed from cells), never typed here. `npm run docs:readme` writes it between the
// README's results markers; readmeResults.test.js fails when the README is out of step.
// A BENCHMARKS edit that renames a section, a row or a column fails it too, naming the
// cell it could not find.

/**
 * The tables of a markdown document by the heading above them:
 * Map<heading text, [{ header: string[], rows: string[][] }]>. A row's empty leading
 * cells repeat the row above (BENCHMARKS writes a block's second tool as `| | Metashape |`);
 * `**bold**` is dropped.
 */
export function markdownTables(md) {
  const tables = new Map()
  let heading = '',
    table = null
  for (const raw of md.split('\n')) {
    // A table may sit indented inside a list item.
    const line = raw.trim()
    const h = /^#{2,4} (.+)$/.exec(line)
    if (h) {
      heading = h[1].trim()
      table = null
      continue
    }
    if (!line.startsWith('|')) {
      table = null
      continue
    }
    const cells = line
      .slice(1, line.endsWith('|') ? line.length - 1 : undefined)
      .split('|')
      .map((c) => c.replaceAll('**', '').trim())
    if (!table) {
      table = { header: cells, rows: [] }
      if (!tables.has(heading)) tables.set(heading, [])
      tables.get(heading).push(table)
    } else if (!cells.every((c) => /^-+$/.test(c))) {
      const prev = table.rows.at(-1)
      let lead = true
      table.rows.push(
        cells.map((c, i) => {
          if (lead && c === '' && prev) return prev[i]
          lead = false
          return c
        }),
      )
    }
  }
  return tables
}

// A cell reader over one document: cell(section, rowTerms, column) → its text. A row is
// the first whose cells start with every term (in any cell); the column is matched by the
// start of its header. Throws naming what it could not find.
export function cellReader(md) {
  const tables = markdownTables(md)
  return function cell(section, rowTerms, column) {
    const where = `BENCHMARKS ▸ ${section} ▸ ${rowTerms.join(' · ')} ▸ ${column}`
    const list = tables.get(section)
    if (!list) throw new Error(`${where}: no section of that name`)
    for (const t of list) {
      const ci = t.header.findIndex((h) => h.startsWith(column))
      if (ci < 0) continue
      const row = t.rows.find((r) => rowTerms.every((term) => r.some((c) => c.startsWith(term))))
      if (row) return row[ci]
    }
    throw new Error(`${where}: no such row and column`)
  }
}

// The first number in a cell ("38/38 · 7.5" → 38, "1,104" → 1104).
const num = (text, i = 0) =>
  Number(
    text
      .match(/[−-]?[\d,]*\.?\d+/g)
      [i].replace(/,/g, '')
      .replace('−', '-'),
  )
const range = (vals, f = (v) => v) => {
  const lo = Math.min(...vals),
    hi = Math.max(...vals)
  return lo === hi ? `${f(lo)}` : `${f(lo)}–${f(hi)}`
}

const ETH3D = ['courtyard', 'delivery_area', 'office', 'pipes', 'playground', 'terrace']
const BLOCKS = ['quarry', 'GeoScan PUTI', 'UseGeo']

// A cell without the checkpoint count or the registered cameras it may carry in brackets.
const bare = (text) => text.replace(/\s*\([^)]*\)\s*$/, '')
// The registered cameras a cell names in brackets ("20.0 / 11.3 (346/347)"), else all.
const registered = (text, all) => /\((\d+)\/(\d+)\)/.exec(text)?.slice(1).join(' / ') ?? all

/** The README's results table (markdown, no trailing newline) from BENCHMARKS.md's text. */
export function readmeResultsTable(benchmarks) {
  const cell = cellReader(benchmarks)
  const free = 'Drone blocks, no positions in the solve'
  const rtk = 'Drone blocks, RTK positions in the solve'
  const pipeline = 'Full pipeline: time and memory'
  const sparse = 'ETH3D high-res and South Building'
  const casa = 'Casa Grande 1978: 37 scans of 9139² px, 44 GCPs'
  const iceland = 'Iceland 1980: 125 scans of 11425² px, 70 GCPs'
  const strecha = 'Strecha multi-view sets'

  // Sparse: registered cameras and median errors per scene (cells "38/38 · 5.84 · …").
  const scenes = [...ETH3D, 'South Building']
  const regSum = (section, tool, list) => {
    const parts = list.map((s) => cell(section, [s], tool).split('·')[0].trim().split('/').map(Number))
    return `${parts.reduce((a, p) => a + p[0], 0)} / ${parts.reduce((a, p) => a + p[1], 0)}`
  }
  const err = (section, tool, s) => num(cell(section, [s], tool).split('·')[1])
  const failed = (section, tool, list) =>
    list.reduce((a, s) => a + Number(/(\d+) of \d+ runs failed/.exec(cell(section, [s], tool))?.[1] ?? 0), 0)
  const gap = range(
    ETH3D.map((s) => err(sparse, 'WebSfM', s) - err(sparse, 'Metashape', s)),
    (v) => v.toFixed(2).replace(/0$/, ''),
  )
  const colmapRatio = range(
    ETH3D.map((s) => err(sparse, 'COLMAP', s) / err(sparse, 'WebSfM', s)),
    (v) => (v < 10 ? v.toFixed(1) : Math.round(v)),
  )

  // Held-out Strecha: where WebSfM's median error is the lowest of the three.
  const SETS = ['fountain-P11', 'Herz-Jesu-P8', 'Herz-Jesu-P25', 'entry-P10', 'castle-P19', 'castle-P30']
  const best = SETS.filter((s) =>
    ['COLMAP', 'Metashape'].every((t) => err(strecha, 'WebSfM', s) < err(strecha, t, s)),
  ).length

  // Full pipeline: totals in minutes and peaks in GiB, over the three blocks.
  const total = (tool) => range(BLOCKS.map((b) => Math.round(num(cell(pipeline, [b, tool], 'total')) / 60)))
  const peak = (tool) => range(BLOCKS.map((b) => num(cell(pipeline, [b, tool], 'peak'))))

  // Dense: the mean F1 and total time of each tool ("69.5 · 794 s").
  const dense = "ETH3D high-res, ETH3D's own evaluator"
  const denseMean = (tool) =>
    cell(dense, ['mean'], tool)
      .split('·')
      .map((p) => p.trim())

  const film = (section, run) => ({
    cameras: cell(section, [run], 'cameras'),
    checkpoints: bare(cell(section, [run], 'checkpoints')),
    dem: cell(section, [run], 'DEM vs reference'),
    coverage: cell(section, [run], 'DEM coverage'),
  })
  const cg = film(casa, 'WebSfM')
  const cgMs = film(casa, 'Metashape defaults')
  const il = film(iceland, 'WebSfM')
  const ilMs = film(iceland, 'Metashape defaults')

  const rows = [
    [
      'Aerial survey block with RTK and 15 GCPs (GeoScan PUTI): RTK positions in the solve, every GCP a checkpoint',
      '444 / 444',
      `Checkpoints ${bare(cell(rtk, ['GeoScan PUTI', 'WebSfM'], 'checkpoints'))} cm (H / V); cameras vs RTK ` +
        `${cell(rtk, ['GeoScan PUTI', 'WebSfM'], 'cameras')} cm`,
      `Metashape, same positions and marks: checkpoints ${bare(cell(rtk, ['GeoScan PUTI', 'Metashape'], 'checkpoints'))} cm, ` +
        `cameras ${cell(rtk, ['GeoScan PUTI', 'Metashape'], 'cameras')} cm`,
    ],
    [
      'Drone block with RTK in the photos (EuroSDR Wards Hill, 500 photos): RTK positions in the solve, 58 checkpoints',
      '500 / 500',
      `Checkpoints ${bare(cell(rtk, ['EuroSDR', 'WebSfM'], 'checkpoints'))} cm (H / V)`,
      `Metashape: ${bare(cell(rtk, ['EuroSDR', 'Metashape'], 'checkpoints'))} cm`,
    ],
    [
      'GeoScan PUTI, pure SfM (no GCPs, no RTK)',
      registered(cell(free, ['GeoScan PUTI'], 'WebSfM'), '444 / 444'),
      `Cameras vs RTK ${bare(cell(free, ['GeoScan PUTI'], 'WebSfM'))} cm (H / V)`,
      `Metashape: ${bare(cell(free, ['GeoScan PUTI'], 'Metashape'))} cm; COLMAP: ` +
        `${bare(cell(free, ['GeoScan PUTI'], 'COLMAP'))} cm; ODM: ${bare(cell(free, ['GeoScan PUTI'], 'ODM'))} cm`,
    ],
    [
      'Quarry, Pix4D example (RTK in EXIF), pure SfM',
      registered(cell(free, ['quarry'], 'WebSfM'), '347 / 347'),
      `Cameras vs RTK ${bare(cell(free, ['quarry'], 'WebSfM'))} cm (H / V)`,
      `Metashape: ${bare(cell(free, ['quarry'], 'Metashape'))} cm; COLMAP: ${bare(cell(free, ['quarry'], 'COLMAP'))} cm; ` +
        `ODM: ${bare(cell(free, ['quarry'], 'ODM'))} cm`,
    ],
    [
      'Three drone blocks (224–444 photos), whole pipeline at defaults: dense cloud, DSM, ortho, textured mesh',
      'all',
      `${total('WebSfM')} min, ${peak('WebSfM')} GiB (a smaller mesh and a coarser orthophoto than Metashape makes by default)`,
      `Metashape: ${total('Metashape')} min, ${peak('Metashape')} GiB; ODM: ${total('ODM')} min, ${peak('ODM')} GiB`,
    ],
    [
      'ETH3D high-res (6 training scenes) and COLMAP South Building, sparse, five runs per tool',
      regSum(sparse, 'WebSfM', scenes),
      `Every camera in every run; median error ${range(
        ETH3D.map((s) => err(sparse, 'WebSfM', s)),
        (v) => v.toFixed(1),
      )} mm, ` + "lower than Metashape's on South Building",
      `Metashape: ${gap} mm lower on ETH3D, but a wrong camera arrangement in ` +
        `${failed(sparse, 'Metashape', ETH3D)} of its 30 runs there; COLMAP: median errors ${colmapRatio}× WebSfM's`,
    ],
    [
      'ETH3D high-res, dense from the ground-truth cameras',
      '–',
      `Mean F1 ${denseMean('WebSfM')[0]} at 2 cm (ETH3D's evaluator) in ${denseMean('WebSfM')[1]}`,
      `Metashape Medium: ${denseMean('Metashape Medium')[0]} in ${denseMean('Metashape Medium')[1]}; High: ` +
        `${denseMean('Metashape High')[0]} in ${denseMean('Metashape High')[1]}; COLMAP: ${denseMean('COLMAP')[0]}`,
    ],
    [
      'Bundle Adjustment in the Large: 98 problems, 16–13,682 cameras (bundle adjustment alone)',
      '–',
      `Final cost a median ${cell('Bundle adjustment against Ceres (BAL)', ['all'], 'cost vs Ceres')} from Ceres' ` +
        `on ${cell('Bundle adjustment against Ceres (BAL)', ['all'], 'problems')} problems, at ` +
        `${cell('Bundle adjustment against Ceres (BAL)', ['all'], 'time vs Ceres')} its time`,
      'Ceres 2.2',
    ],
    [
      'Casa Grande 1978 aerial film (37 scans, GCPs in the solve, every fourth a checkpoint)',
      cg.cameras.replace('/', ' / '),
      `Checkpoints ${cg.checkpoints} m (H / V); DEM vs 1 m reference RMSE / NMAD ${cg.dem} m, covering ${cg.coverage}`,
      `Metashape defaults: ${cgMs.cameras}, checkpoints ${cgMs.checkpoints} m, DEM ${cgMs.dem} m, covering ${cgMs.coverage}`,
    ],
    [
      'Iceland 1980 aerial film (125 scans, GCPs in the solve)',
      il.cameras.replace('/', ' / '),
      `Checkpoints ${il.checkpoints} m; DEM RMSE / NMAD ${il.dem} m, covering ${il.coverage}`,
      `Metashape defaults: ${ilMs.cameras}, checkpoints ${ilMs.checkpoints} m, DEM ${ilMs.dem} m, covering ${ilMs.coverage}`,
    ],
    [
      "Strecha's six multi-view sets, held out (never used to tune WebSfM)",
      regSum(strecha, 'WebSfM', SETS),
      `Lowest median camera error of the three tools on ${best} of 6`,
      `Metashape: ${SETS.filter((s) => err(strecha, 'Metashape', s) < err(strecha, 'WebSfM', s)).length} of 6; ` +
        `COLMAP: ${regSum(strecha, 'COLMAP', SETS)}, median errors ` +
        `${range(
          SETS.map((s) => err(strecha, 'COLMAP', s) / err(strecha, 'WebSfM', s)),
          (v) => v.toFixed(1),
        )}× WebSfM's`,
    ],
  ]
  return [
    '| Dataset | Images registered | Result | Compared against |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

export const RESULTS_START = '<!-- results:start: made by `npm run docs:readme` from docs/BENCHMARKS.md -->'
export const RESULTS_END = '<!-- results:end -->'

/** The README with its results table replaced by the one made from BENCHMARKS. */
export function readmeWithResults(readme, benchmarks) {
  const a = readme.indexOf(RESULTS_START),
    b = readme.indexOf(RESULTS_END)
  if (a < 0 || b < a) throw new Error('README.md has no results markers')
  return `${readme.slice(0, a + RESULTS_START.length)}\n${readmeResultsTable(benchmarks)}\n${readme.slice(b)}`
}
