// The regression gate: one block of each kind (gate.json) through detection, matching and
// the sparse model, compared with the committed baseline (gate-baseline.json). Run it for
// any change to detection, matching, verification or SfM, and give its table in the commit
// (docs/conventions.md ▸ An option or not). About 15 minutes on this machine's GPU.
//
//   node scripts/bench/suites/gate.mjs [--only <id>[,<id>…]] [--out <dir>] [--port 4187]
//        [--dump]             also save each set's SfM input to gate.json's dumpDir, the
//                             inputs of the CPU gate (npm run gate:sfm)
//        [--write-baseline]   make this run the baseline (a clean tree, every set)
//
// Fails (exit 1) on a camera lost, a camera more off the reference, a median camera error
// over 1.25× the baseline's, or a different photo count (the data changed). Warns on
// points seen in three or more photos under 0.9× the baseline, a run over 1.5× as long,
// and more photos registered near the correspondence floor (registration margin, logged
// by the sparse run). A full run's verdict goes to .git/websfm-gate.log by commit, which
// the pre-push hook (.githooks/pre-push) reads.
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTruth, scoreCameras } from '../score/camera-score.mjs'
import { EXP, checkOut, today } from '../lib/paths.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true
  else ((args[a.slice(2)] = next), i++)
}
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim()
const sha = git('rev-parse', 'HEAD')
const dirty = git('status', '--porcelain', '--untracked-files=no', '--', 'src', 'crates', 'scripts').length > 0
const manifest = JSON.parse(await readFile(join(repo, 'scripts/bench/suites/gate.json'), 'utf8'))
const baselinePath = join(repo, 'scripts/bench/suites/gate-baseline.json')
const baseline = existsSync(baselinePath) ? JSON.parse(await readFile(baselinePath, 'utf8')) : { sets: {} }
const only = args.only ? new Set(String(args.only).split(',')) : null
const sets = manifest.sets.filter((s) => !only || only.has(s.id))
// Every gate run of a day in one experiment, a folder per commit.
const out = checkOut(resolve(args.out ?? join(EXP, `${today()}-gate`, sha.slice(0, 7))))
const port = Number(args.port ?? 4187)
if (args['write-baseline'] && (dirty || only)) {
  console.error('--write-baseline needs a clean tree and every set')
  process.exit(2)
}
await mkdir(out, { recursive: true })

const run = (cmd, argv, logPath) =>
  new Promise((done) => {
    const p = spawn(cmd, argv, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    p.stdout.on('data', (d) => chunks.push(d))
    p.stderr.on('data', (d) => chunks.push(d))
    p.on('close', async (code) => {
      await writeFile(logPath, Buffer.concat(chunks))
      done(code)
    })
  })

const results = {}
for (const s of sets) {
  const cfg = { name: `gate-${s.id}`, ...s.config, stages: 'detect,match,recon', port }
  if (args.dump) cfg.dumpSfmInput = true
  const cfgPath = join(out, `${s.id}.config.json`)
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2))
  const t0 = Date.now()
  process.stdout.write(`${s.id} … `)
  const code = await run(
    process.execPath,
    [join(repo, 'scripts/bench/websfm/run-bench.mjs'), '--config', cfgPath, '--out', join(out, s.id)],
    join(out, `${s.id}.log`),
  )
  const wall = (Date.now() - t0) / 1000
  let r = null
  try {
    const res = JSON.parse(await readFile(join(out, `${s.id}.json`), 'utf8'))
    const rec = Array.isArray(res.stages?.recon) ? res.stages.recon[0] : res.stages?.recon
    if (rec?.model) {
      r = {
        images: rec.images ?? res.files,
        cameras: Object.keys(rec.model).length,
        points: rec.points ?? null,
        pointsGe3: rec.pointsGe3 ?? null,
        seconds: Math.round(wall),
        nearFloor: rec.registrationMargin?.nearFloor ?? null,
      }
      if (s.truth) {
        const c = scoreCameras(rec.model, readTruth(s.truth))
        Object.assign(r, { median: c.median, p90: c.p90, off: c.off, offNames: c.offNames })
      }
    }
  } catch {
    r = null
  }
  if (args.dump && r && manifest.dumpDir) {
    await mkdir(manifest.dumpDir, { recursive: true })
    await copyFile(join(out, `${s.id}.recon.sfminput`), join(manifest.dumpDir, `${s.id}.sfminput`))
  }
  results[s.id] = r ?? { error: `no sparse model (exit ${code}, see ${s.id}.log)` }
  console.log(r ? `${r.cameras}/${r.images}${r.median != null ? ` · ${r.median}` : ''} in ${r.seconds} s` : 'FAILED')
}

// Compare with the baseline.
const fails = []
const warns = []
const fmtErr = (v, unit) => (v == null ? '–' : unit === 'mm' ? (v * 1000).toFixed(2) : v.toPrecision(2))
const rows = []
for (const s of sets) {
  const r = results[s.id]
  const b = baseline.sets?.[s.id]
  const notes = []
  if (r.error) (fails.push(`${s.id}: ${r.error}`), notes.push('**no model**'))
  else if (b) {
    if (r.images !== b.images) fails.push(`${s.id}: ${r.images} photos, baseline ${b.images} (data changed?)`)
    if (r.cameras < b.cameras)
      (fails.push(`${s.id}: ${r.cameras} cameras, baseline ${b.cameras}`), notes.push('**cameras lost**'))
    if ((r.off ?? 0) > (b.off ?? 0))
      (fails.push(`${s.id}: ${r.off} cameras off, baseline ${b.off}`), notes.push('**off**'))
    if (r.median != null && b.median != null && r.median > 1.25 * b.median)
      (fails.push(`${s.id}: median ${r.median}, baseline ${b.median}`), notes.push('**median**'))
    if (r.pointsGe3 != null && b.pointsGe3 != null && r.pointsGe3 < 0.9 * b.pointsGe3)
      (warns.push(`${s.id}: ${r.pointsGe3} points in 3+ photos, baseline ${b.pointsGe3}`), notes.push('points'))
    if (b.seconds && r.seconds > 1.5 * b.seconds)
      (warns.push(`${s.id}: ${r.seconds} s, baseline ${b.seconds} s`), notes.push('slow'))
    if (r.nearFloor != null && b.nearFloor != null && r.nearFloor > b.nearFloor)
      (warns.push(`${s.id}: ${r.nearFloor} photos near the floor, baseline ${b.nearFloor}`), notes.push('margin'))
  } else notes.push('no baseline')
  const was = (k, f = (v) => v) => (b?.[k] != null ? ` (${f(b[k])})` : '')
  rows.push(
    `| ${s.id} | ${r.error ? '–' : `${r.cameras}/${r.images}${was('cameras')}`} | ` +
      `${r.error ? '–' : `${fmtErr(r.median, s.unit)}${was('median', (v) => fmtErr(v, s.unit))}`} | ` +
      `${r.off ?? '–'} | ${r.pointsGe3?.toLocaleString('en') ?? '–'} | ${r.nearFloor ?? '–'} | ${r.seconds ?? '–'} | ${notes.join(', ') || 'ok'} |`,
  )
}
const pass = fails.length === 0
const md = [
  `Gate ${pass ? 'PASSED' : 'FAILED'} at ${sha.slice(0, 7)}${dirty ? ' (uncommitted changes)' : ''}, baseline ${baseline.commit?.slice(0, 7) ?? 'none'}`,
  '',
  '| set | cameras (baseline) | median error, mm or model units (baseline) | off | points in 3+ photos | near floor | s | |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows,
  ...(fails.length ? ['', 'Failed:', ...fails.map((f) => `- ${f}`)] : []),
  ...(warns.length ? ['', 'Warnings:', ...warns.map((w) => `- ${w}`)] : []),
].join('\n')
console.log(`\n${md}`)
await writeFile(join(out, 'gate.md'), md + '\n')
await writeFile(join(out, 'gate.json'), JSON.stringify({ sha, dirty, pass, fails, warns, results }, null, 2))

if (!only) {
  const ledger = join(resolve(repo, git('rev-parse', '--git-common-dir')), 'websfm-gate.log')
  await appendFile(
    ledger,
    `${sha} ${dirty ? 'dirty' : 'clean'} ${pass ? 'pass' : 'FAIL'} ${new Date().toISOString()} ${out}\n`,
  )
}
if (args['write-baseline']) {
  if (!Object.values(results).every((r) => !r.error)) {
    console.error('not writing a baseline: a set has no model')
    process.exit(1)
  }
  const sets = Object.fromEntries(
    Object.entries(results).map(([id, r]) => [
      id,
      Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'offNames')),
    ]),
  )
  await writeFile(
    baselinePath,
    JSON.stringify({ commit: sha, date: new Date().toISOString().slice(0, 10), sets }, null, 2) + '\n',
  )
  console.log(`baseline written: ${baselinePath}`)
}
process.exit(pass ? 0 : 1)
