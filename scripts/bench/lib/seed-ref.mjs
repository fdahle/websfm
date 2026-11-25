// Seed ref/ from scoreboard runs made before records existed (one-off, kept for the next
// such import): each reference job of the current manifest whose old folder finished, whose
// config (its paths mapped to today's layout) decides the same result, and whose runner has
// not changed since (`--rev`, default 1 for every tool), is stored as if it had run now.
//
//   node scripts/bench/lib/seed-ref.mjs --from <scoreboard run> [--from …] [--paths rewrites.json]
//        [--skip <job id>,…] [--dry-run]
//
// rewrites.json: [[old, new], …] path rewrites applied to the old config copies (the
// 2026-11-25 tidy moved the eval folders). The record says `legacy: true`: the commit and
// the backend of the run are unknown, the machine is assumed to be this one.

import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { EVAL, repo } from './paths.mjs'
import { RECORD, datasetFingerprint, machine, toolVersionOf, fileHash } from './record.mjs'
import { RUNNER_REV, configHash, linkEvidence, refKey } from './refstore.mjs'
import { SUMMARY_FILE, configPath, loadConfig } from './jobs.mjs'

const argv = process.argv.slice(2)
const multi = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))
const one = (k) => multi(k)[0]
const dry = argv.includes('--dry-run')
const skip = new Set((one('skip') ?? '').split(',').filter(Boolean))
const rewrites = one('paths') ? JSON.parse(readFileSync(one('paths'), 'utf8')) : []
const rewrite = (s) => {
  let t = s
  for (const [a, b] of [...rewrites].sort((x, y) => y[0].length - x[0].length)) t = t.split(a).join(b)
  return t
}
const manifest = JSON.parse(readFileSync(join(repo, 'scripts/bench/suites/scoreboard.json'), 'utf8'))
const jobs = manifest.tables.flatMap((t) => t.jobs.map((j) => ({ ...j, table: t.id })))

// The version a legacy summary names (else the one installed, which the run used: one
// Metashape and one COLMAP on this machine since October).
function legacyVersion(job, s) {
  if (job.tool === 'odm') return s?.odm?.image?.split('@')[1]?.slice(7, 19) ?? null
  return toolVersionOf(job.tool, s)
}

for (const from of multi('from')) {
  const progress = existsSync(join(from, 'progress.log')) ? readFileSync(join(from, 'progress.log'), 'utf8') : ''
  for (const job of jobs) {
    if (!(job.tool in RUNNER_REV) || skip.has(job.id)) continue
    const dir = join(from, job.id)
    const summary = join(dir, SUMMARY_FILE[job.tool] ?? 'summary.json')
    if (!existsSync(summary)) continue
    const lastDone = [...progress.matchAll(new RegExp(`done ${job.id} exit (\\d+)`, 'g'))].pop()
    const say = (m) => console.log(`${job.id.padEnd(40)} ${m}`)
    if (lastDone && lastDone[1] !== '0') {
      say(`skip: last run exit ${lastDone[1]}`)
      continue
    }
    const oldCfgFile = join(from, 'configs', `${job.config}.json`)
    if (!existsSync(oldCfgFile)) {
      say('skip: no config copy')
      continue
    }
    const cfg = await loadConfig(job.config)
    const oldCfg = JSON.parse(rewrite(readFileSync(oldCfgFile, 'utf8')))
    if (configHash(oldCfg) !== configHash(cfg)) {
      say('skip: config changed')
      continue
    }
    const s = JSON.parse(readFileSync(summary, 'utf8'))
    const version = legacyVersion(job, s)
    const key = refKey(job, cfg, version)
    if (RUNNER_REV[job.tool] !== 1) {
      say(`skip: runner revised since (rev ${RUNNER_REV[job.tool]})`)
      continue
    }
    const to = join(EVAL, 'ref', `${job.tool}-${version ?? 'unknown'}`, `${job.id}-${key.hash.slice(0, 8)}`)
    if (!version) {
      say('skip: version unknown')
      continue
    }
    say(`store → ${relative(EVAL, to)}`)
    if (dry) continue
    linkEvidence(dir, to)
    const record = {
      schema: 1,
      tool: job.tool,
      toolVersion: version,
      config: { name: job.config, sha256: fileHash(configPath(job.config)) },
      dataset: datasetFingerprint(cfg.images, cfg),
      code: null,
      machine: machine(),
      machineAssumed: true,
      backend: null,
      exit: 0,
      legacy: true,
      storedFrom: relative(EVAL, dir),
      job: job.id,
      refKey: key,
    }
    await writeFile(join(to, RECORD), JSON.stringify(record, null, 2) + '\n')
  }
}
