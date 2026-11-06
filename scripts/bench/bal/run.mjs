// The bundle adjustment against Ceres on the BAL problems (Bundle Adjustment in the
// Large, grail.cs.washington.edu/projects/bal): the same objective (½·Σ‖r‖², no robust
// loss, BAL's camera with its own focal, k1, k2), the same start, both on every core.
// Builds crates/reconstruction/examples/bal.rs and ceres_bal.cc, runs each problem with
// Ceres (SPARSE_SCHUR) and the crate's `app` and `pcg` policies, appends one JSON line
// per run to <out>/results.jsonl (a run already there is skipped, so it resumes), and
// prints a summary table.
//
//   node scripts/bench/bal/run.mjs [--data DIR] [--out DIR] [--only SUBSTR] [--max-obs N]
//                                  [--iters N] [--timeout-min N] [--pcg-max-cams N]
//   node scripts/bench/bal/run.mjs --summary [--out DIR]
//
// --data   the problems, <set>/problem-*.txt (default /data1/websfm_testdata/bal)
// --out    results (default /data1/websfm_eval/bal)
// --pcg-max-cams  the `pcg` policy only up to this many cameras (default 600): it is the
//          app's former solve, minutes where the others take seconds, and above ~600
//          cameras the app never used it. 0 = never, Infinity = every problem.
// CERES_PREFIX: a Ceres 2.x install with glog, gflags and Eigen (default the colmap_env
// conda env). The comparison is on the final cost: iteration counts are reported but are
// not comparable (Ceres' trust region against the crate's LM with damping retries).
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs'
import { cpus, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const data = arg('data', '/data1/websfm_testdata/bal')
const out = arg('out', '/data1/websfm_eval/bal')
const only = arg('only', '')
const maxObs = Number(arg('max-obs', Infinity))
const iters = Number(arg('iters', 100))
const timeoutMs = Number(arg('timeout-min', 120)) * 60_000
const pcgMaxCams = Number(arg('pcg-max-cams', 600))
const threads = cpus().length
const results = join(out, 'results.jsonl')
mkdirSync(out, { recursive: true })

const readResults = () =>
  existsSync(results)
    ? readFileSync(results, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []

function summary() {
  const rows = readResults()
  const by = new Map()
  for (const r of rows) {
    const k = r.file.split('/').slice(-2).join('/')
    if (!by.has(k)) by.set(k, {})
    by.get(k)[r.solver] = r
  }
  const keys = [...by.keys()].sort((a, b) => {
    const [x, y] = [by.get(a), by.get(b)].map((m) => Object.values(m)[0].observations)
    return x - y
  })
  // A websfm row written before the harness reported the solver's own cost as
  // `final_cost` holds it as `solver_final_cost` (its `final_cost` was BAL's formula on the
  // f32 output, which rounding inflates; examples/bal.rs).
  const final = (r) => r.solver_final_cost ?? r.final_cost
  const rel = (a, b) => (a && b && !a.error && !b.error ? (final(a) - final(b)) / final(b) : NaN)
  const fmt = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toExponential(1) : '—')
  const time = (r) => (r && !r.error ? r.solve_s.toFixed(1) : r?.error ? 'ERR' : '—')
  console.log(
    'problem'.padEnd(40) +
      'cams'.padStart(6) +
      'obs'.padStart(10) +
      '  ceres cost'.padStart(14) +
      '  app Δ'.padStart(10) +
      '  pcg Δ'.padStart(10) +
      '  t ceres'.padStart(9) +
      '  t app'.padStart(8) +
      '  t pcg'.padStart(8) +
      '  it c/a/p',
  )
  const ratios = { app: [], pcg: [] }
  for (const k of keys) {
    const m = by.get(k)
    const c = m['ceres-sparse_schur'],
      a = m['websfm-app'],
      p = m['websfm-pcg']
    const any = c ?? a ?? p
    for (const [name, r] of [
      ['app', a],
      ['pcg', p],
    ])
      if (Number.isFinite(rel(r, c))) ratios[name].push(rel(r, c))
    console.log(
      k.padEnd(40) +
        String(any.cameras).padStart(6) +
        String(any.observations).padStart(10) +
        (c && !c.error ? c.final_cost.toExponential(4) : '—').padStart(14) +
        fmt(rel(a, c)).padStart(10) +
        fmt(rel(p, c)).padStart(10) +
        time(c).padStart(9) +
        time(a).padStart(8) +
        time(p).padStart(8) +
        `  ${c?.iterations ?? '—'}/${a?.iterations ?? '—'}/${p?.iterations ?? '—'}` +
        ([a, p].some((r) => r?.mapping_ok === false) ? '  MAPPING MISMATCH' : ''),
    )
  }
  for (const [name, v] of Object.entries(ratios)) {
    if (!v.length) continue
    const s = [...v].sort((x, y) => x - y)
    const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))]
    console.log(
      `${name}: final cost vs Ceres over ${s.length} problems — median ${fmt(q(0.5))}, ` +
        `90 % ${fmt(q(0.9))}, max ${fmt(s[s.length - 1])}, min ${fmt(s[0])}; ` +
        `${s.filter((x) => x > 1e-3).length} more than 0.1 % above`,
    )
  }
}

if (process.argv.includes('--summary')) {
  summary()
  process.exit(0)
}

// Build both programs.
const prefix = process.env.CERES_PREFIX || join(homedir(), 'miniconda3/envs/colmap_env')
const ceresBin = join(out, 'ceres_bal')
execFileSync(
  'g++',
  [
    '-O2',
    '-std=c++17',
    '-DGLOG_USE_GLOG_EXPORT',
    '-DGLOG_USE_GFLAGS',
    `-I${prefix}/include`,
    `-I${prefix}/include/eigen3`,
    join(repo, 'scripts/bench/bal/ceres_bal.cc'),
    '-o',
    ceresBin,
    `-L${prefix}/lib`,
    `-Wl,-rpath,${prefix}/lib`,
    '-lceres',
    '-lglog',
    '-lgflags',
  ],
  { stdio: 'inherit' },
)
execFileSync('cargo', ['build', '--release', '--features', 'threads', '--example', 'bal'], {
  cwd: join(repo, 'crates/reconstruction'),
  stdio: 'inherit',
})
const websfmBin = join(repo, 'crates/target/release/examples/bal')

// A problem's observation count, from its first line (the largest file is over a GB).
function headerObs(f) {
  const fd = openSync(f, 'r')
  const buf = Buffer.alloc(64)
  readSync(fd, buf, 0, 64, 0)
  closeSync(fd)
  return Number(buf.toString('latin1').trim().split(/\s+/)[2])
}

const problems = readdirSync(data)
  .flatMap((set) =>
    statSync(join(data, set)).isDirectory()
      ? readdirSync(join(data, set))
          .filter((f) => /^problem-\d+-\d+.*\.txt$/.test(f))
          .map((f) => join(data, set, f))
      : [],
  )
  .filter((f) => f.includes(only))
  .map((f) => ({ f, obs: headerObs(f), cams: Number(/problem-(\d+)-/.exec(f)[1]) }))
  .filter((p) => p.obs <= maxObs)
  .sort((a, b) => a.obs - b.obs)

const done = new Set(readResults().map((r) => `${r.file}|${r.solver}`))
const runs = [
  ['ceres-sparse_schur', ceresBin, (f) => [f, String(iters), String(threads), 'sparse_schur']],
  ['websfm-app', websfmBin, (f) => [f, 'app', String(iters)]],
  ['websfm-pcg', websfmBin, (f) => [f, 'pcg', String(iters)]],
]
console.log(`${problems.length} problems, ${threads} threads, up to ${iters} iterations → ${results}`)
for (const { f, obs, cams } of problems) {
  for (const [solver, bin, args] of runs) {
    if (done.has(`${f}|${solver}`)) continue
    if (solver === 'websfm-pcg' && cams > pcgMaxCams) continue
    const t0 = Date.now()
    const r = spawnSync(bin, args(f), { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 20 })
    let line
    try {
      line = JSON.parse(r.stdout.trim().split('\n').pop())
    } catch {
      line = {
        file: f,
        solver,
        observations: obs,
        error: r.error?.code ?? `exit ${r.status}${r.signal ? ` ${r.signal}` : ''}: ${(r.stderr || '').slice(-300)}`,
        wall_s: (Date.now() - t0) / 1000,
      }
    }
    appendFileSync(results, JSON.stringify(line) + '\n')
    console.log(
      `${f.split('/').slice(-2).join('/')} ${solver}: ` +
        (line.error
          ? `ERROR ${line.error}`
          : `cost ${line.final_cost.toExponential(6)} in ${line.solve_s.toFixed(1)} s`),
    )
  }
}
summary()
