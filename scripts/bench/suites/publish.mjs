// Publish a scoreboard run: its scores to docs/benchmarks.json and its tables into
// docs/BENCHMARKS.md, so BENCHMARKS.md, the README (made from BENCHMARKS) and the paper
// (publication/tables/make-tables.mjs reads the same pin) all carry one run's numbers.
//
//   npm run bench -- publish            from scripts/bench/published.json
//   npm run bench -- publish --check    exit 1 when the files would change (nothing written)
//
// published.json names the run (results/<name>) and any earlier runs that count as more
// repeats of some tools' jobs (`repeats`: a folder, the tools and tables it serves). Each
// job's score is the median over its sound runs, by the scoreboard's own scoreOf and
// aggregateRuns (a run far off the others counts as failed and is reported, not averaged).

import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EVAL, repo } from '../lib/paths.mjs'
import { SUMMARY_FILE } from '../lib/jobs.mjs'
import { withTables } from '../lib/bench-tables.mjs'
import { aggregateRuns, scoreOf } from './scoreboard.mjs'

const check = process.argv.includes('--check')
const pin = JSON.parse(await readFile(join(repo, 'scripts/bench/published.json'), 'utf8'))
const manifest = JSON.parse(await readFile(join(repo, 'scripts/bench/suites/scoreboard.json'), 'utf8'))
const runDir = join(EVAL, pin.run)
if (!existsSync(runDir)) throw new Error(`no run at ${runDir} (published.json ▸ run)`)

const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null)
function scoreDir(job, dir) {
  if (!existsSync(join(dir, SUMMARY_FILE[job.tool] ?? 'summary.json'))) return null
  return scoreOf(job.tool, read(join(dir, SUMMARY_FILE[job.tool] ?? 'summary.json')), {
    checkpoints: read(join(dir, 'checkpoints.json')),
    cameraCheck: read(join(dir, 'camera-check.json')),
    eth3d: read(join(dir, 'eth3d.json')),
    eth3dOfficial: read(join(dir, 'eth3d-official.json')),
  })
}

const jobs = []
for (const t of manifest.tables)
  for (const j of t.jobs) {
    const dirs = [join(runDir, j.id)]
    for (let r = 2; existsSync(join(runDir, `${j.id}~${r}`)); r++) dirs.push(join(runDir, `${j.id}~${r}`))
    for (const rep of pin.repeats ?? [])
      if (rep.tools.includes(j.tool) && rep.tables.includes(t.id)) dirs.push(join(EVAL, rep.dir, j.id))
    const runs = dirs.map((d) => scoreDir(j, d)).filter(Boolean)
    const agg = runs.length ? aggregateRuns(runs) : null
    jobs.push({
      id: j.id,
      table: t.id,
      block: j.block,
      label: j.label ?? j.tool,
      tool: j.tool,
      unit: j.unit ?? t.unit ?? 'm',
      runs: runs.length,
      // Full precision: rounding here and again when a cell is formatted would round a value
      // on an edge (an even count's median, 2.1149999…) differently from the paper.
      failed: agg ? agg.failed : [],
      score: agg ? agg.score : null,
    })
  }

const rec = read(join(runDir, jobs.find((j) => j.tool === 'websfm')?.id ?? '', 'record.json'))
const data = {
  about: 'Scores of the published scoreboard run (scripts/bench/suites/publish.mjs); edit published.json, not this.',
  run: pin.run,
  commit: rec?.code?.sha?.slice(0, 8) ?? null,
  repeats: pin.repeats ?? [],
  jobs,
}

const dataFile = join(repo, 'docs/benchmarks.json')
const mdFile = join(repo, 'docs/BENCHMARKS.md')
const dataText = JSON.stringify(data, null, 1) + '\n'
const md = await readFile(mdFile, 'utf8')
const mdNew = withTables(md, data)
const changed = [
  [dataFile, dataText, existsSync(dataFile) ? readFileSync(dataFile, 'utf8') : ''],
  [mdFile, mdNew, md],
].filter(([, a, b]) => a !== b)

if (check) {
  for (const [f] of changed) console.log(`would change: ${f.replace(repo + '/', '')}`)
  process.exitCode = changed.length ? 1 : 0
} else {
  for (const [f, text] of changed) await writeFile(f, text)
  const short = jobs.filter((j) => !j.score).map((j) => j.id)
  console.log(`published ${pin.run}: ${jobs.length} jobs${short.length ? `, no result for ${short.join(', ')}` : ''}`)
  console.log(
    changed.length ? changed.map(([f]) => `wrote ${f.replace(repo + '/', '')}`).join('\n') : 'nothing changed',
  )
}
