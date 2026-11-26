// The benchmark scoreboard: every tool on every block of docs/BENCHMARKS.md, run one after
// another on one date, scored the same way, written as the page's tables.
//
//   node scripts/bench/suites/scoreboard.mjs [--manifest scripts/bench/suites/scoreboard.json]
//        [--name <name>]                                results/<name> (default <date>-<commit>)
//        [--out <dir>]                                  or any folder: results, logs, configs
//        [--only <table>[,<table>…]]                    some tables
//        [--jobs <id>[,<id>…]]                          some jobs
//        [--heldout]                                    also the held-out tables (a release run)
//        [--repeat <n>]                                 each WebSfM job n times (a release run: 3)
//        [--dry-run]                                    print the commands, run nothing
//        [--tabulate]                                   no runs: tables from what <out> holds
//        [--pack]                                       <out>.tar.gz: configs, logs, summaries
//        [--no-reuse]                                   run every reference job again (else ref/, lib/refstore.mjs)
//
// The manifest (committed) lists tables, and in each the jobs: a tool and a bench config
// by name (scripts/bench/configs/<config>.json, gitignored: they hold local paths). Each job
// writes <out>/<job id>/; a job whose summary is already there is skipped, so a run that
// stopped picks up where it left off. The configs are copied to <out>/configs/ and named in
// each table row, and --pack bundles them with the logs and summaries (not the photos,
// models or rasters) as the release asset of that benchmark date.
//
// A table with `heldout: true` runs only with --heldout, at a release: its sets are never
// used to choose a default or tune a method, so their numbers say how WebSfM does on data
// nobody fitted it to. Don't run them while developing, and don't change code because of them
// without saying so in the CHANGELOG (the set is then no longer held out).
//
// Tools: websfm (run-bench.mjs), metashape (ref/metashape.mjs; `checkpoints: true` scores
// the config's GCP marks with metashape_checkpoints.py), metashape-hist
// (hist/metashape_hist.py, the film blocks), colmap (ref/colmap.mjs; with `--model <scene>/
// dslr_calibration_undistorted --imagePath <scene>/images --dense` in `args`, dense from
// ETH3D's cameras), colmap-hist (hist/colmap_hist.py: the film blocks, the GCPs fitted by a
// similarity after the adjustment, leave-one-out checkpoints), odm (ref/odm.mjs).
// `args` are passed to the tool as they are. `truth` (an ETH3D scene folder or a COLMAP
// images.txt) scores the run's cameras with camera-check.mjs into camera-check.json, for the
// `truth` column; `unit` on a job overrides its table's (South Building is in model units).
// `eth3d` (an ETH3D scene folder) scores the run's dense cloud with eth3d_score.py
// --occlusion min into eth3d.json, for the `f1` column: the websfm run's exportDense cloud,
// or metashape-dense's (metashape_dense.py: Metashape's cloud from the scene's
// ground-truth cameras), or colmap's dense/fused.ply. The same cloud is also scored by
// ETH3D's own evaluator (eth3d_official.py, a C++ build outside the repo: see its header)
// into eth3d-official.json, for the `f1Official` column. Every run is sequential: two at
// once and both timings lie. A scoring step whose result file is missing runs even when
// the job's summary is there, so a new score reaches an old run without rerunning it.
//
// --repeat n runs each WebSfM job n times, the repeats in <job id>~2, <job id>~3 … (a run
// varies: thread timing and the GPU reorder sums, and a knife-edge block shows it), and the
// table gives the median of each number with every run's cell beside it. The other tools'
// versions are pinned, so they run once.

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RESULTS, checkOut, repo, today } from '../lib/paths.mjs'
import { SUMMARY_FILE, commandsOf, configPath, loadConfig, runJob, runStep } from '../lib/jobs.mjs'
import { findStored, reuse, store } from '../lib/refstore.mjs'
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true
  else ((args[a.slice(2)] = next), i++)
}
const manifestPath = resolve(args.manifest ?? join(repo, 'scripts/bench/suites/scoreboard.json'))
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
// A run's name: --name (a release: its version), else <date>-<commit>.
const shortSha = () =>
  spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim()
const out = resolve(args.out ?? join(RESULTS, String(args.name ?? `${today()}-${shortSha()}`)))
const only = args.only ? new Set(String(args.only).split(',')) : null
const pick = args.jobs ? new Set(String(args.jobs).split(',')) : null

const heldBack = manifest.tables.filter((t) => t.heldout && !args.heldout && (!only || only.has(t.id)))
if (heldBack.length) console.log(`held out (add --heldout at a release): ${heldBack.map((t) => t.id).join(', ')}`)
const tables = manifest.tables.filter((t) => (!only || only.has(t.id)) && (!t.heldout || args.heldout))
const repeat = Math.max(1, Number(args.repeat) || 1)
// A job and its repeats (WebSfM only): the ids whose folders hold its runs.
const runIdsOf = (j) =>
  j.tool === 'websfm' ? Array.from({ length: repeat }, (_, r) => (r ? `${j.id}~${r + 1}` : j.id)) : [j.id]
const jobs = tables
  .flatMap((t) => t.jobs.map((j) => ({ ...j, table: t.id })))
  .filter((j) => !pick || pick.has(j.id))
  .flatMap((j) => runIdsOf(j).map((id) => ({ ...j, id })))
const ids = new Set()
for (const j of jobs) {
  if (ids.has(j.id)) throw new Error(`job id ${j.id} twice in the manifest`)
  ids.add(j.id)
}

const read = async (f) => (existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null)

// One tool's result in common terms: lengths in metres, times in seconds.
export function scoreOf(tool, s, extra = {}) {
  if (!s) return null
  const cc = extra.cameraCheck
  const truth = cc ? { registered: cc.registered, median: cc.median, off: cc.off ?? 0 } : null
  const at2 = (e) => {
    const row = e?.rows?.find((r) => Math.abs(r.tolerance - 0.02) < 1e-9)
    return row ? { f1: row.f1, accuracy: row.accuracy, completeness: row.completeness } : null
  }
  return {
    ...scoreOfTool(tool, s, extra),
    truth,
    dense: at2(extra.eth3d),
    denseOfficial: at2(extra.eth3dOfficial),
    denseSeconds: denseSecondsOf(tool, s),
    pipe: pipeOf(tool, s),
    lidar: lidarOf(tool, s, extra.lidar),
  }
}

// The full pipeline's stages in common terms (seconds), peak memory (GiB) and dense points.
function pipeOf(tool, s) {
  const sum = (o, ks) => ks.reduce((a, k) => a + (o?.[k] ?? 0), 0)
  if (tool === 'websfm') {
    const st = s.stages ?? {}
    if (!st.texture && !st.ortho) return null
    const sec = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v?.seconds ?? 0]))
    return {
      total: sum(sec, Object.keys(sec)),
      sfm: sum(sec, ['ingest', 'detect', 'match', 'recon']),
      dense: sum(sec, ['depth', 'dense']),
      mesh: sec.mesh ?? null,
      texture: sec.texture ?? null,
      dsmOrtho: sum(sec, ['dem', 'ortho']),
      peakGB: s.procPeakGB ?? null,
      densePoints: st.dense?.points ?? null,
    }
  }
  if (tool === 'metashape' && s.seconds?.orthomosaic != null) {
    const t = s.seconds
    return {
      total: t.total,
      sfm: sum(t, ['addPhotos', 'matching', 'alignment']),
      dense: sum(t, ['depthMaps', 'pointCloud']),
      mesh: t.mesh,
      texture: sum(t, ['uv', 'texture']),
      dsmOrtho: sum(t, ['dem', 'orthomosaic']),
      peakGB: s.peakRssMiB != null ? s.peakRssMiB / 1024 : null,
      densePoints: s.densePoints ?? null,
    }
  }
  if (tool === 'odm' && s.odm?.mode === 'full') {
    const t = s.stageSeconds ?? {}
    return {
      total: s.seconds,
      sfm: sum(t, ['dataset', 'split', 'merge', 'opensfm']),
      dense: sum(t, ['openmvs', 'odm_filterpoints']),
      mesh: t.odm_meshing ?? null,
      texture: t.mvs_texturing ?? null,
      dsmOrtho: sum(t, ['odm_georeferencing', 'odm_dem', 'odm_orthophoto']),
      peakGB: s.peakMemMiB != null ? s.peakMemMiB / 1024 : null,
      densePoints: s.densePoints ?? null,
    }
  }
  return null
}

// The dense cloud against airborne LiDAR: WebSfM's from its run, the others' from lidar.json.
function lidarOf(tool, s, extra) {
  const r = tool === 'websfm' ? s.stages?.dense?.lidarCheck : extra
  return r && !r.error ? r : null
}

// Depth maps + fusion (WebSfM) or depth maps + point cloud from the given cameras (Metashape).
function denseSecondsOf(tool, s) {
  if (tool === 'websfm') return (s.stages?.depth?.seconds ?? 0) + (s.stages?.dense?.seconds ?? 0) || null
  if (tool === 'metashape-dense') return s.seconds?.denseTotal ?? null
  if (tool === 'colmap' && s.dense) {
    const t = s.seconds ?? {}
    return (t.undistort ?? 0) + (t.patchmatch ?? 0) + (t.fusion ?? 0) || null
  }
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
      // Copying the photos into the browser counts too: COLMAP's and ODM's times include
      // reading them, and leaving it out would flatter WebSfM.
      sfmSeconds: sec('ingest') + sec('detect') + sec('match') + sec('recon') || null,
    }
  }
  if (tool === 'colmap-hist') {
    const g = s.georef ?? {}
    const dem = s.dem_score
    const t = s.timings ?? {}
    return {
      cameras: g.registered != null ? [g.registered, s.images ?? null] : null,
      position: null,
      checkpoints:
        g.loo_rms_h != null ? { h: g.loo_rms_h, v: g.loo_rms_v, meanU: null, n: s.checkpoints ?? null } : null,
      dem: dem ? { rmse: dem.rmse_diff, nmad: dem.nmad_diff, coverage: dem.dem_valid_share_of_bbox } : null,
      sfmSeconds: (t.features ?? 0) + (t.matching ?? 0) + (t.mapper ?? 0) || null,
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

const secs = (v) => (v != null && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–')
const pipeCol = (key, head) => ({ head, cell: (x) => (x.pipe ? secs(x.pipe[key]) : '–') })
export const COLUMNS = {
  pipeTotal: pipeCol('total', 'total (s)'),
  pipeSfm: pipeCol('sfm', 'import + SfM'),
  pipeDense: pipeCol('dense', 'depth + dense'),
  pipeMesh: pipeCol('mesh', 'mesh'),
  pipeTexture: pipeCol('texture', 'texture'),
  pipeDsmOrtho: pipeCol('dsmOrtho', 'DSM + ortho'),
  peak: { head: 'peak (GiB)', cell: (x) => (x.pipe?.peakGB ? String(Math.round(x.pipe.peakGB)) : '–') },
  densePoints: {
    head: 'dense points',
    cell: (x) => (x.pipe?.densePoints ? `${Math.round(x.pipe.densePoints / 1e6)} M` : '–'),
  },
  lidar: {
    head: 'vs LiDAR: median · within 10 cm',
    cell: (x) =>
      x.lidar ? `${(x.lidar.medianAbsM * 100).toFixed(1)} cm · ${Math.round(x.lidar.within10cm * 100)} %` : '–',
  },
  lidarDome: {
    head: 'without the bowl',
    cell: (x) =>
      x.lidar?.domeMedianAbsM != null
        ? `${(x.lidar.domeMedianAbsM * 100).toFixed(1)} cm · ${Math.round(x.lidar.domeWithin10cm * 100)} %`
        : '–',
  },
  bowl: {
    head: 'bowl at the edge (m)',
    cell: (x) => (x.lidar?.domeAtEdgeM != null ? x.lidar.domeAtEdgeM.toFixed(2) : '–'),
  },
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
  f1Official: {
    head: 'F1 at 2 cm, ETH3D evaluator (%) · accuracy / completeness',
    cell: (x) =>
      x.denseOfficial
        ? `${x.denseOfficial.f1.toFixed(1)} · ${x.denseOfficial.accuracy.toFixed(0)} / ${x.denseOfficial.completeness.toFixed(0)}`
        : '–',
  },
  denseTime: {
    head: 'dense time (s)',
    cell: (x) => (x.denseSeconds ? Math.round(x.denseSeconds).toLocaleString('en-US') : '–'),
  },
  time: { head: 'SfM time (s)', cell: (x) => (x.sfmSeconds ? Math.round(x.sfmSeconds).toLocaleString('en-US') : '–') },
}
// Results are in metres (ETH3D, the drone blocks) or the reference's own units (`model`).
// Where each tool's runner writes its summary (commandsOf names the same files).
export const SCALE = { m: 1, cm: 100, mm: 1000, model: 1 }
function fmt(v) {
  if (v == null || !Number.isFinite(v)) return '–'
  if (v !== 0 && Math.abs(v) < 0.1) return v.toPrecision(2) // model units (South Building)
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)
}

// The median of several runs' scores, number by number (one run: itself; none: null).
export function medianScore(runs) {
  if (runs.length < 2) return runs[0] ?? null
  const merge = (vals) => {
    const v = vals.find((x) => x != null)
    if (typeof v === 'number') {
      const s = vals.filter(Number.isFinite).sort((a, b) => a - b)
      const m = s.length >> 1
      return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null
    }
    if (Array.isArray(v)) return v.map((_, i) => merge(vals.map((x) => x?.[i])))
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.keys(v).map((key) => [key, merge(vals.map((x) => x?.[key]))]))
    return v ?? null
  }
  return merge(runs)
}

// A run whose median camera error is more than this many times the median of the job's runs
// went wrong (a wrong camera arrangement, not a less accurate one): it counts as failed.
export const FAIL_FACTOR = 10

/**
 * Several runs of one job → { score, repeats, failed, spread }: the median of the sound runs
 * (medianScore), the runs left out as failed (their median camera errors), and the spread of
 * the sound runs' median errors. Runs without a camera error (checkpoint, DEM and dense
 * tables) are all sound. docs/BENCHMARKS.md (publish.mjs) and the paper's tables both use this.
 */
export function aggregateRuns(runs) {
  const meds = runs.map((r) => r?.truth?.median)
  if (runs.length >= 3 && meds.every((v) => v != null && Number.isFinite(v))) {
    const all = medianScore(meds.map((m) => ({ m }))).m
    const sound = runs.filter((r) => r.truth.median <= FAIL_FACTOR * all)
    const sm = sound.map((r) => r.truth.median)
    return {
      score: medianScore(sound),
      repeats: runs.length,
      failed: runs.filter((r) => r.truth.median > FAIL_FACTOR * all).map((r) => r.truth.median),
      spread: Math.max(...sm) - Math.min(...sm),
    }
  }
  return { score: medianScore(runs), repeats: runs.length, failed: [], spread: null }
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
      const runs = []
      for (const id of runIdsOf(j)) {
        const dir = join(out, id)
        const s = await read(join(dir, SUMMARY_FILE[j.tool] ?? 'summary.json'))
        const x = scoreOf(j.tool, s, {
          checkpoints: await read(join(dir, 'checkpoints.json')),
          cameraCheck: await read(join(dir, 'camera-check.json')),
          eth3d: await read(join(dir, 'eth3d.json')),
          eth3dOfficial: await read(join(dir, 'eth3d-official.json')),
          lidar: await read(join(dir, 'lidar.json')),
        })
        if (x) runs.push(x)
      }
      const k = SCALE[j.unit ?? unit] ?? 1
      const x = medianScore(runs)
      const cell = (c) => {
        const mid = COLUMNS[c].cell(x, k)
        if (runs.length < 2) return mid
        const each = runs.map((r) => COLUMNS[c].cell(r, k))
        return new Set(each).size === 1 ? `${mid} [${runs.length} runs, alike]` : `${mid} [${each.join('; ')}]`
      }
      const cells = x ? cols.map(cell) : cols.map(() => 'not run')
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
  const keep = /\.(json|log|txt|md|out|csv)$/i // record.json included
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
  const code = await runStep('tar', ['-czf', tar, '-C', out, '-T', list], join(out, 'pack.log'))
  console.log(
    code === 0 ? `packed ${files.length} files → ${tar}` : `tar failed (${code}), see ${join(out, 'pack.log')}`,
  )
}

// Run only as a script: importing this file (for scoreOf) must not start any job.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  if (!args['dry-run']) await mkdir(join(checkOut(out), 'configs'), { recursive: true })
  if (args.pack)
    for (const job of jobs)
      if (existsSync(join(out, job.id)) && existsSync(configPath(job.config)))
        await copyFile(configPath(job.config), join(out, 'configs', `${job.config}.json`))
  if (!args.tabulate) {
    const progress = join(out, 'progress.log')
    const log = (m) => appendFile(progress, `${new Date().toISOString().slice(11, 19)} ${m}\n`)
    for (const job of jobs) {
      const dir = join(out, job.id)
      const { summary, steps } = await commandsOf(job, dir)
      // A reference tool's result from ref/ when nothing that decides it changed (lib/refstore.mjs).
      const cfg = job.tool === 'websfm' || args['no-reuse'] ? null : await loadConfig(job.config)
      const hit = cfg && !existsSync(summary) ? findStored(job, cfg) : null
      if (args['dry-run']) {
        console.log(`# ${job.id}${hit ? `  (reused: ${hit.dir})` : ''}`)
        if (hit) continue
        for (const [exe, argv] of steps) console.log([exe, ...argv].join(' '))
        continue
      }
      await copyFile(configPath(job.config), join(out, 'configs', `${job.config}.json`))
      if (hit) {
        await reuse(hit, dir, { table: job.table, run: out.split('/').pop(), job: job.id })
        await log(`reused ${job.id} from ${hit.dir}`)
      }
      if (existsSync(summary)) {
        const todo = steps.filter(([, , o]) => o?.creates && !existsSync(o.creates))
        await log(`skip ${job.id} (summary there)${todo.length ? `; scoring ${todo.length} missing` : ''}`)
        for (const [exe, argv, opts] of todo) {
          const code = await runStep(exe, argv, join(dir, 'console.log'), opts)
          await log(`scored ${job.id}: ${opts.creates.split('/').pop()} exit ${code}`)
        }
        continue
      }
      await log(`start ${job.id}`)
      const code = await runJob(job, dir, { extra: { table: job.table, run: out.split('/').pop() } })
      await log(`done ${job.id} exit ${code}`)
      if (code === 0 && job.tool !== 'websfm') {
        const kept = await store(job, await loadConfig(job.config), dir).catch((e) => console.error(e.message))
        if (kept) await log(`stored ${job.id} in ${kept}`)
      }
    }
    if (!args['dry-run']) await log('scoreboard finished')
  }
  if (!args['dry-run']) await tabulate()
  if (args.pack) await pack()
}
