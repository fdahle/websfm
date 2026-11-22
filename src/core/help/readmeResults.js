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
const BLOCKS = ['quarry', 'PUTI', 'UseGeo']

/** The README's results table (markdown, no trailing newline) from BENCHMARKS.md's text. */
export function readmeResultsTable(benchmarks) {
  const cell = cellReader(benchmarks)
  const free = 'Drone blocks, no positions in the solve'
  const rtk = 'Drone blocks, RTK positions in the solve'
  const pipeline = 'Full pipeline: time and memory'
  const sparse = 'ETH3D high-res and South Building'
  const casa = 'Casa Grande 1978: 37 scans of 9139² px, 44 GCPs'
  // DEMs compared on the cells every tool's DEM covers (score_dem.py --also).
  const common = 'DEM vs reference on the common cells'
  const iceland = 'Iceland 1980: 125 scans of 11425² px, 70 GCPs'

  // Sparse: registered cameras and median errors per scene (cells "38/38 · 7.5").
  const scenes = [...ETH3D, 'South Building']
  const regSum = (tool, list = scenes) => {
    const parts = list.map((s) => cell(sparse, [s], tool).split('·')[0].trim().split('/').map(Number))
    return `${parts.reduce((a, p) => a + p[0], 0)} / ${parts.reduce((a, p) => a + p[1], 0)}`
  }
  const err = (tool, s) => num(cell(sparse, [s], tool).split('·')[1])
  const ahead = scenes.filter((s) => err('WebSfM', s) < err('Metashape', s)).length
  const colmapRatio = range(
    ETH3D.map((s) => err('COLMAP', s) / err('WebSfM', s)),
    (v) => Math.round(v),
  )

  // Full pipeline: totals in minutes and peaks in GiB, over the three blocks.
  const total = (tool) => range(BLOCKS.map((b) => Math.round(num(cell(pipeline, [b, tool], 'total')) / 60)))
  const peak = (tool) => range(BLOCKS.map((b) => num(cell(pipeline, [b, tool], 'peak'))))

  // Dense: the approximate scorer's means and totals ("69.7 · 827 s").
  const dense = 'ETH3D high-res against Metashape'
  const eth3dDense = "ETH3D high-res, ETH3D's own evaluator"
  const denseMean = (tool) => cell(dense, ['mean'], tool)
  const f1Gap = (num(denseMean('Metashape Medium')) - num(denseMean('WebSfM'))).toFixed(1)

  const rows = [
    [
      'Aerial survey block with RTK and 15 GCPs (GeoScan PUTI): RTK positions in the solve, every GCP a checkpoint',
      '444 / 444',
      `Checkpoints ${cell(rtk, ['GeoScan PUTI', 'WebSfM'], 'checkpoints')} cm (H / V); cameras vs RTK ` +
        `${cell(rtk, ['GeoScan PUTI', 'WebSfM'], 'cameras')} cm`,
      `Metashape, same positions and marks: checkpoints ${cell(rtk, ['GeoScan PUTI', 'Metashape'], 'checkpoints')} cm, ` +
        `cameras ${cell(rtk, ['GeoScan PUTI', 'Metashape'], 'cameras')} cm`,
    ],
    [
      'Same block, pure SfM (no GCPs, no RTK)',
      '444 / 444',
      `Cameras vs RTK ${cell(free, ['GeoScan PUTI'], 'WebSfM')} cm (H / V)`,
      `COLMAP: ${cell(free, ['GeoScan PUTI'], 'COLMAP')} cm; ODM: ${cell(free, ['GeoScan PUTI'], 'ODM')} cm`,
    ],
    [
      'Quarry, Pix4D example (RTK in EXIF), pure SfM',
      '346 / 347',
      `Cameras vs RTK ${cell(free, ['quarry'], 'WebSfM')} cm (H / V)`,
      `Metashape: ${cell(free, ['quarry'], 'Metashape')} cm; COLMAP: ${cell(free, ['quarry'], 'COLMAP')} cm; ` +
        `ODM: ${cell(free, ['quarry'], 'ODM')} cm`,
    ],
    [
      'Three drone blocks (224–444 photos), whole pipeline at defaults: dense cloud, DSM, ortho, textured mesh',
      'all',
      `${total('WebSfM')} min, ${peak('WebSfM')} GiB (smaller mesh and ortho than the others make by default)`,
      `Metashape: ${total('Metashape')} min, ${peak('Metashape')} GiB; ODM: ${total('ODM')} min, ${peak('ODM')} GiB`,
    ],
    [
      'ETH3D high-res (6 training scenes) and COLMAP South Building, sparse',
      regSum('WebSfM'),
      `Median camera error level with Metashape's: lower on ${ahead} of ${scenes.length}`,
      `Metashape: ${regSum('Metashape')}; COLMAP: ${regSum('COLMAP', ETH3D)} on ETH3D, median errors ${colmapRatio}× WebSfM's`,
    ],
    [
      'ETH3D high-res, dense from the ground-truth cameras',
      '–',
      `Mean F1 ${cell(eth3dDense, ['mean'], 'WebSfM')} at 2 cm (ETH3D's evaluator)`,
      `COLMAP: ${cell(eth3dDense, ['mean'], 'COLMAP')}. Metashape Medium: ` +
        `${f1Gap} points higher in half the time (${denseMean('Metashape Medium').split('·')[1].trim()} against ` +
        `${denseMean('WebSfM').split('·')[1].trim()}; approximate scorer)`,
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
      cell(casa, ['WebSfM, preprocessed scans (11'], 'cameras'),
      `Checkpoints ${cell(casa, ['WebSfM, preprocessed scans (11'], 'checkpoints')} (H / V); DEM vs 1 m ` +
        `reference RMSE / NMAD ${cell(casa, ['WebSfM, preprocessed scans'], common)} on the cells every ` +
        `tool's DEM covers (WebSfM's covers ${cell(casa, ['WebSfM, preprocessed scans (11'], 'DEM coverage')})`,
      `Metashape defaults: ${cell(casa, ['Metashape defaults'], 'cameras')} cameras, checkpoints ` +
        `${cell(casa, ['Metashape defaults'], 'checkpoints')}, DEM ${cell(casa, ['Metashape defaults'], common)} ` +
        `(covers ${cell(casa, ['Metashape defaults'], 'DEM coverage')}); with guided matching ` +
        `${cell(casa, ['Metashape, 80'], 'cameras')}, DEM ${cell(casa, ['Metashape, 80'], common)} ` +
        `(${cell(casa, ['Metashape, 80'], 'DEM coverage')})`,
    ],
    [
      'Iceland 1980 aerial film (125 scans, GCPs in the solve)',
      cell(iceland, ['WebSfM (11'], 'cameras'),
      `Checkpoints ${cell(iceland, ['WebSfM (11'], 'checkpoints')}; DEM RMSE / NMAD ` +
        `${cell(iceland, ['WebSfM (11'], common)} on the cells both DEMs cover (WebSfM's covers ` +
        `${cell(iceland, ['WebSfM (11'], 'DEM coverage')})`,
      `Metashape defaults: ${cell(iceland, ['Metashape defaults'], 'cameras')}, checkpoints ` +
        `${cell(iceland, ['Metashape defaults'], 'checkpoints')}, DEM ${cell(iceland, ['Metashape defaults'], common)} ` +
        `(covers ${cell(iceland, ['Metashape defaults'], 'DEM coverage')})`,
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
