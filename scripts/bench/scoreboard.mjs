// The benchmark scoreboard: every tool on every block of docs/BENCHMARKS.md, run one after
// another on one date, scored the same way, written as the page's tables.
//
//   node scripts/bench/scoreboard.mjs [--manifest scripts/bench/scoreboard.json]
//        [--out /data1/websfm_eval/scoreboard-<date>]   results, logs and the configs used
//        [--only <table>[,<table>…]]                    some tables
//        [--jobs <id>[,<id>…]]                          some jobs
//        [--dry-run]                                    print the commands, run nothing
//        [--tabulate]                                   no runs: tables from what <out> holds
//        [--pack]                                       <out>.tar.gz: configs, logs, summaries
//
// The manifest (committed) lists tables, and in each the jobs: a tool and a bench config
// by name (scripts/bench/configs/<config>.json, gitignored: they hold local paths). Each job
// writes <out>/<job id>/; a job whose summary is already there is skipped, so a run that
// stopped picks up where it left off. The configs are copied to <out>/configs/ and named in
// each table row, and --pack bundles them with the logs and summaries (not the photos,
// models or rasters) as the release asset of that benchmark date.
//
// Tools: websfm (run-bench.mjs), metashape (metashape-ref.mjs; `checkpoints: true` scores
// the config's GCP marks with metashape_checkpoints.py), metashape-hist
// (hist/metashape_hist.py, the film blocks), colmap (colmap-ref.mjs), odm (odm-ref.mjs).
// `args` are passed to the tool as they are. `truth` (an ETH3D scene folder or a COLMAP
// images.txt) scores the run's cameras with camera-check.mjs into camera-check.json, for the
// `truth` column; `unit` on a job overrides its table's (South Building is in model units).
// `eth3d` (an ETH3D scene folder) scores the run's dense cloud with eth3d_score.py
// --occlusion min into eth3d.json, for the `f1` column: the websfm run's exportDense cloud,
// or metashape-dense's (metashape_dense.py: Metashape's cloud from the scene's
// ground-truth cameras). Every run is sequential: two at once and both timings lie.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true
  else ((args[a.slice(2)] = next), i++)
}
const date = new Date().toISOString().slice(0, 10)
const manifestPath = resolve(args.manifest ?? join(repo, 'scripts/bench/scoreboard.json'))
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const out = resolve(args.out ?? `/data1/websfm_eval/scoreboard-${date}`)
const python = process.env.METASHAPE_PYTHON ?? join(homedir(), 'miniconda3/envs/hist_env3/bin/python')
const only = args.only ? new Set(String(args.only).split(',')) : null
const pick = args.jobs ? new Set(String(args.jobs).split(',')) : null

const tables = manifest.tables.filter((t) => !only || only.has(t.id))
const jobs = tables.flatMap((t) => t.jobs.map((j) => ({ ...j, table: t.id }))).filter((j) => !pick || pick.has(j.id))
const ids = new Set()
for (const j of jobs) {
  if (ids.has(j.id)) throw new Error(`job id ${j.id} twice in the manifest`)
  ids.add(j.id)
}

// The thinned ETH3D scans, built once per scene by eth3d_score.py (a minute each) and kept.
const ETH3D_GT_CACHE = process.env.ETH3D_GT_CACHE ?? '/data1/websfm_eval/eth3d-gt-cache'
const configPath = (name) => join(repo, 'scripts/bench/configs', `${name}.json`)
const loadConfig = async (name) => JSON.parse(await readFile(configPath(name), 'utf8'))
const epsgOf = (crs) => String(crs ?? '').replace(/^EPSG:+/i, '')

// The command lines of one job: [exe, argv][] run in order, and where its summary lands.
async function toolCommandsOf(job) {
  const cfg = await loadConfig(job.config)
  const dir = join(out, job.id)
  const extra = job.args ?? []
  const node = (script, argv) => [process.execPath, [join(repo, 'scripts/bench', script), ...argv]]
  switch (job.tool) {
    case 'websfm':
      return {
        summary: join(dir, 'run.json'),
        steps: [node('run-bench.mjs', ['--config', configPath(job.config), '--out', join(dir, 'run'), ...extra])],
      }
    case 'metashape': {
      const steps = [
        node('metashape-ref.mjs', ['--config', configPath(job.config), '--ws', dir, '--name', job.id, ...extra]),
      ]
      if (job.checkpoints) {
        const ref = cfg.reference ?? {}
        if (!ref.gcps || !ref.metashape)
          throw new Error(`${job.id}: checkpoints need reference.gcps and reference.metashape`)
        steps.push([
          python,
          [
            join(repo, 'scripts/bench/metashape_checkpoints.py'),
            ...['--project', join(dir, 'project.psx'), '--gcps', ref.gcps, '--marks', ref.metashape],
            ...(ref.excludeGcps?.length ? ['--exclude', ...ref.excludeGcps] : []),
            ...['--out', join(dir, 'checkpoints.json')],
          ],
        ])
      }
      return { summary: join(dir, 'summary.json'), steps }
    }
    case 'metashape-hist': {
      const h = cfg.hist ?? {}
      const argv = [join(repo, 'scripts/bench/hist/metashape_hist.py'), '--images', cfg.images, '--ws', dir]
      if (h.mask) argv.push('--mask', h.mask)
      if (h.gcps) argv.push('--gcps', h.gcps)
      if (h.intrinsics) argv.push('--intrinsics', h.intrinsics)
      if (cfg.crs) argv.push('--epsg', epsgOf(cfg.crs))
      if (h.refDem) argv.push('--ref-dem', h.refDem)
      return { summary: join(dir, 'summary.json'), steps: [[python, [...argv, ...extra]]] }
    }
    case 'metashape-dense': {
      if (!job.eth3d) throw new Error(`${job.id}: metashape-dense needs eth3d (the scene folder)`)
      const argv = [join(repo, 'scripts/bench/metashape_dense.py'), '--scene', job.eth3d, '--ws', dir]
      return { summary: join(dir, 'metashape.json'), steps: [[python, [...argv, ...extra]]] }
    }
    case 'colmap':
      return {
        summary: join(dir, 'summary.json'),
        steps: [node('colmap-ref.mjs', ['--config', configPath(job.config), '--ws', dir, '--name', job.id, ...extra])],
      }
    case 'odm':
      return {
        summary: join(dir, 'summary.json'),
        steps: [node('odm-ref.mjs', ['--config', configPath(job.config), '--ws', dir, ...extra])],
      }
    default:
      throw new Error(`${job.id}: unknown tool ${job.tool}`)
  }
}

// The tool's steps, then the camera check against `truth` when the job names one.
async function commandsOf(job) {
  const c = await toolCommandsOf(job)
  if (job.truth)
    c.steps.push([
      process.execPath,
      [join(repo, 'scripts/bench/camera-check.mjs'), c.summary, job.truth],
      { stdout: join(out, job.id, 'camera-check.json') },
    ])
  if (job.eth3d) {
    const dir = join(out, job.id)
    const cloud = job.tool === 'websfm' ? join(dir, 'run.dense.bin') : join(dir, 'dense.ply')
    c.steps.push([
      python,
      [
        join(repo, 'scripts/bench/eth3d_score.py'),
        ...['--scene', job.eth3d, '--recon', cloud, '--occlusion', 'min', '--label', job.id],
        ...['--cache', ETH3D_GT_CACHE, '--out', join(dir, 'eth3d.json')],
      ],
    ])
  }
  return c
}

// `opts.stdout`: a file that takes the step's standard output alone (a JSON line).
function run(exe, argv, logFile, opts = {}) {
  return new Promise((done) => {
    const p = spawn(exe, argv, { cwd: repo, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } })
    const write = (b) => appendFile(logFile, b)
    let stdout = ''
    p.stdout.on('data', opts.stdout ? (b) => (stdout += b) : write)
    p.stderr.on('data', write)
    p.on('close', async (code) => {
      if (opts.stdout) await writeFile(opts.stdout, stdout)
      done(code)
    })
  })
}

const r = (v, d) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)))
const read = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null)

// One tool's result in common terms: lengths in metres, times in seconds.
export function scoreOf(tool, s, extra = {}) {
  if (!s) return null
  const cc = extra.cameraCheck
  const truth = cc ? { registered: cc.registered, median: cc.median, off: cc.off ?? 0 } : null
  const at2 = extra.eth3d?.rows?.find((row) => Math.abs(row.tolerance - 0.02) < 1e-9)
  const dense = at2 ? { f1: at2.f1, accuracy: at2.accuracy, completeness: at2.completeness } : null
  return { ...scoreOfTool(tool, s, extra), truth, dense, denseSeconds: denseSecondsOf(tool, s) }
}

// Depth maps + fusion (WebSfM) or depth maps + point cloud from the given cameras (Metashape).
function denseSecondsOf(tool, s) {
  if (tool === 'websfm') return (s.stages?.depth?.seconds ?? 0) + (s.stages?.dense?.seconds ?? 0) || null
  if (tool === 'metashape-dense') return s.seconds?.denseTotal ?? null
  return null
}

function scoreOfTool(tool, s, extra) {
  if (tool === 'metashape-dense') return { cameras: [s.posed, s.cameras] }
  const pos = (pc) => (pc ? { h: pc.rmsH, v: pc.rmsV } : null)
  if (tool === 'websfm') {
    const st = s.stages ?? {}
    const rec = st.recon ?? {}
    const cc = rec.checkpointCheck && !rec.checkpointCheck.error ? rec.checkpointCheck : null
    const gc = rec.gcpResiduals?.check
    const chk = cc
      ? { h: cc.rmsH, v: cc.rmsV, meanU: cc.meanU, n: cc.count }
      : gc
        ? { h: gc.rmsH, v: gc.rmsV, meanU: gc.meanU, n: gc.n }
        : null
    const dem = st.dem?.demScore
    const sec = (k) => st[k]?.seconds ?? 0
    return {
      cameras: rec.cameras != null ? [rec.cameras, rec.images] : null,
      position: pos(rec.positionCheck),
      checkpoints: chk,
      dem: dem ? { rmse: dem.rmse_diff, nmad: dem.nmad_diff, coverage: dem.dem_valid_share_of_bbox } : null,
      sfmSeconds: sec('detect') + sec('match') + sec('recon') || null,
    }
  }
  if (tool === 'metashape-hist') {
    const dem = s.dem_score
    return {
      cameras: [s.registered, s.images],
      position: null,
      checkpoints: s.n_check ? { h: s.check_rms_h, v: s.check_rms_v, meanU: null, n: s.n_check } : null,
      dem: dem ? { rmse: dem.rmse_diff, nmad: dem.nmad_diff, coverage: dem.dem_valid_share_of_bbox } : null,
      sfmSeconds: s.timings?.align ?? null,
    }
  }
  const ck = extra.checkpoints
  return {
    cameras: [s.registered, s.images],
    position: pos(s.positionCheck),
    checkpoints: ck ? { h: ck.rmsH, v: ck.rmsV, meanU: ck.meanV, n: ck.count } : null,
    dem: null,
    sfmSeconds:
      tool === 'odm'
        ? (s.stageSeconds?.opensfm ?? null)
        : typeof s.seconds === 'object'
          ? (s.seconds.sfmTotal ?? null)
          : (s.seconds ?? null),
  }
}

const COLUMNS = {
  cameras: { head: 'cameras', cell: (x) => (x.cameras ? `${x.cameras[0]}/${x.cameras[1]}` : '–') },
  truth: {
    head: (u) => `cameras · median error vs truth (${u})`,
    cell: (x, k) =>
      x.truth ? `${x.truth.registered} · ${fmt(x.truth.median * k)}${x.truth.off ? ` · ${x.truth.off} off` : ''}` : '–',
  },
  position: {
    head: (u) => `cameras vs reference (${u})`,
    cell: (x, k) => (x.position ? `${fmt(x.position.h * k)} / ${fmt(x.position.v * k)}` : '–'),
  },
  checkpoints: {
    head: (u) => `checkpoints (${u})`,
    cell: (x, k) =>
      x.checkpoints ? `${fmt(x.checkpoints.h * k)} / ${fmt(x.checkpoints.v * k)} (${x.checkpoints.n})` : '–',
  },
  meanHeight: {
    head: (u) => `mean height error (${u})`,
    cell: (x, k) =>
      x.checkpoints?.meanU != null ? `${x.checkpoints.meanU >= 0 ? '+' : ''}${fmt(x.checkpoints.meanU * k)}` : '–',
  },
  dem: {
    head: () => 'DEM RMSE / NMAD (m)',
    cell: (x) => (x.dem ? `${fmt(x.dem.rmse)} / ${fmt(x.dem.nmad)}` : '–'),
  },
  coverage: { head: 'DEM coverage', cell: (x) => (x.dem ? `${Math.round(x.dem.coverage * 100)} %` : '–') },
  f1: {
    head: 'F1 at 2 cm (%) · accuracy / completeness',
    cell: (x) =>
      x.dense ? `${x.dense.f1.toFixed(1)} · ${x.dense.accuracy.toFixed(0)} / ${x.dense.completeness.toFixed(0)}` : '–',
  },
  denseTime: {
    head: 'dense time (s)',
    cell: (x) => (x.denseSeconds ? Math.round(x.denseSeconds).toLocaleString('en-US') : '–'),
  },
  time: { head: 'SfM time (s)', cell: (x) => (x.sfmSeconds ? Math.round(x.sfmSeconds).toLocaleString('en-US') : '–') },
}
// Results are in metres (ETH3D, the drone blocks) or the reference's own units (`model`).
// Where each tool's runner writes its summary (commandsOf names the same files).
const SUMMARY_FILE = { 'websfm': 'run.json', 'metashape-dense': 'metashape.json' }
const SCALE = { m: 1, cm: 100, mm: 1000, model: 1 }
function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '–'
  if (v !== 0 && Math.abs(v) < 0.1) return v.toPrecision(2) // model units (South Building)
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)
}

async function tabulate() {
  const lines = [`# Scoreboard ${out.split('/').pop()}`, '', `Manifest: ${manifestPath.replace(repo + '/', '')}`, '']
  for (const t of tables) {
    const unit = t.unit ?? 'm'
    const cols = t.columns ?? ['cameras', 'checkpoints']
    const head = [
      'block',
      'run',
      ...cols.map((c) => (typeof COLUMNS[c].head === 'function' ? COLUMNS[c].head(unit) : COLUMNS[c].head)),
      'config',
    ]
    lines.push(`## ${t.title}`, '', `| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`)
    for (const j of t.jobs) {
      const dir = join(out, j.id)
      const s = await read(join(dir, SUMMARY_FILE[j.tool] ?? 'summary.json'))
      const x = scoreOf(j.tool, s, {
        checkpoints: await read(join(dir, 'checkpoints.json')),
        cameraCheck: await read(join(dir, 'camera-check.json')),
        eth3d: await read(join(dir, 'eth3d.json')),
      })
      const k = SCALE[j.unit ?? unit] ?? 1
      const cells = x ? cols.map((c) => COLUMNS[c].cell(x, k)) : cols.map(() => 'not run')
      const label = `${j.label ?? j.tool}${j.unit && j.unit !== unit ? ` (${j.unit === 'model' ? 'model units' : j.unit})` : ''}`
      lines.push(`| ${j.block} | ${label} | ${cells.join(' | ')} | \`${j.config}\` |`)
    }
    lines.push('')
  }
  await writeFile(join(out, 'scoreboard.md'), lines.join('\n'))
  console.log(lines.join('\n'))
}

async function pack() {
  // Configs, logs and summaries: what someone needs to check a table, without the data.
  const keep = /\.(json|log|txt|md|out|csv)$/i
  const files = []
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const q = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!/\.files$|\.build$|-profile$|^colmap$|^opensfm$|^images?$/i.test(e.name)) await walk(p, q)
      } else if (keep.test(e.name)) files.push(q)
    }
  }
  await walk(out, '')
  const list = join(out, '.pack-list')
  await writeFile(list, files.join('\n'))
  const tar = `${out}.tar.gz`
  const code = await run('tar', ['-czf', tar, '-C', out, '-T', list], join(out, 'pack.log'))
  console.log(
    code === 0 ? `packed ${files.length} files → ${tar}` : `tar failed (${code}), see ${join(out, 'pack.log')}`,
  )
}

// Run only as a script: importing this file (for scoreOf) must not start any job.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (!args['dry-run']) await mkdir(join(out, 'configs'), { recursive: true })
  if (args.pack)
    for (const job of jobs)
      if (existsSync(join(out, job.id)) && existsSync(configPath(job.config)))
        await copyFile(configPath(job.config), join(out, 'configs', `${job.config}.json`))
  if (!args.tabulate) {
    const progress = join(out, 'progress.log')
    const log = (m) => appendFile(progress, `${new Date().toISOString().slice(11, 19)} ${m}\n`)
    for (const job of jobs) {
      const { summary, steps } = await commandsOf(job)
      if (args['dry-run']) {
        console.log(`# ${job.id}`)
        for (const [exe, argv] of steps) console.log([exe, ...argv].join(' '))
        continue
      }
      await copyFile(configPath(job.config), join(out, 'configs', `${job.config}.json`))
      if (existsSync(summary)) {
        await log(`skip ${job.id} (summary there)`)
        continue
      }
      await mkdir(join(out, job.id), { recursive: true })
      await log(`start ${job.id}`)
      let code = 0
      for (const [exe, argv, opts] of steps) {
        code = await run(exe, argv, join(out, job.id, 'console.log'), opts)
        if (code !== 0) break
      }
      await log(`done ${job.id} exit ${code}`)
    }
    if (!args['dry-run']) await log('scoreboard finished')
  }
  if (!args['dry-run']) await tabulate()
  if (args.pack) await pack()
}
