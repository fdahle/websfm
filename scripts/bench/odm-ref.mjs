// ODM reference run on a bench config's images: OpenDroneMap's official Docker image at its
// defaults, timed per stage with its peak memory, and scored with the SAME camera-position
// check the bench applies to WebSfM (refScore.mjs), so ODM sits beside COLMAP and Metashape
// in docs/BENCHMARKS.md.
//
//   node scripts/bench/odm-ref.mjs --config scripts/bench/configs/<cfg>.json
//        --mode sfm|full      sfm: pure SfM, no positions anywhere (GPS stripped from copies
//                             of the photos), stops after OpenSfM — the "positions not in the
//                             solve" tables. full: defaults as a user runs it, positions in
//                             (EXIF GPS, or geo.txt from the config's reference cameras), the
//                             whole pipeline with a DSM and a COPC cloud.
//        [--ws <dir>]         workspace (default /data1/websfm_eval/odm-<date>/<name>-<mode>)
//        [--image <ref>]      Docker image (default opendronemap/odm:latest)
//        [--keep]             keep the photo copies and ODM's intermediate folders
//        [--score-only]       score a finished workspace again (run.json keeps its time and memory)
//
// Photos without EXIF focal length (UseGeo) get the config's `sensor.focal` (px) as a 35 mm
// equivalent, the hint any user would give; ODM still self-calibrates from it.
// Docker runs rootless (`docker context use rootless`). Run it alone, not beside a bench
// run, or both timings lie.
import { spawn, spawnSync } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir, link, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadReference } from './reference.mjs'
import { parseOpenSfm } from '../../src/core/io/sfmInterop.js'
import { scoreCameraPositions, benchModel, stem } from './refScore.mjs'

const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const k = a.slice(2),
    v = process.argv[i + 1]
  if (v == null || v.startsWith('--')) args[k] = true
  else {
    args[k] = v
    i++
  }
}
const cfg = JSON.parse(await readFile(args.config, 'utf8'))
const mode = args.mode ?? 'sfm'
if (!['sfm', 'full'].includes(mode)) throw new Error('--mode sfm|full')
const images = cfg.images
const name = args.name ?? `odm-${cfg.name ?? 'run'}-${mode}`
const day = new Date().toISOString().slice(0, 10)
const ws = resolve(args.ws ?? `/data1/websfm_eval/odm-${day}/${name}`)
const proj = join(ws, 'project')
const imgDir = join(proj, 'images')
const dockerImage = args.image ?? 'opendronemap/odm:latest'
const scoreOnly = !!args['score-only']
await mkdir(imgDir, { recursive: true })

const sh = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${a.slice(0, 3).join(' ')} … failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

// ── photos ──────────────────────────────────────────────────────────────────────────
const files = (await readdir(images)).filter((f) => /\.(jpe?g|tiff?)$/i.test(f)).sort()
const exif0 = JSON.parse(
  sh('exiftool', ['-j', '-n', '-FocalLength', '-GPSLatitude', '-ImageWidth', '-ImageHeight', join(images, files[0])]),
)[0]
const needsFocal = !exif0.FocalLength && cfg.sensor?.focalUnit === 'px' && cfg.sensor?.focal
const needsCopy = mode === 'sfm' || needsFocal
const have = new Set(await readdir(imgDir))
if (scoreOnly) {
  // nothing to prepare
} else if (needsCopy) {
  // exiftool -o writes new files: the test data is never touched.
  const todo = files.filter((f) => !have.has(f))
  if (todo.length) {
    const edits = []
    if (mode === 'sfm') edits.push('-gps:all=')
    if (needsFocal) {
      const w = Math.max(exif0.ImageWidth, exif0.ImageHeight)
      edits.push(`-FocalLengthIn35mmFormat=${Math.round((cfg.sensor.focal / w) * 36)}`)
    }
    console.log(`== copying ${todo.length} photos (${edits.join(' ')})`)
    for (let i = 0; i < todo.length; i += 50)
      sh('exiftool', ['-q', ...edits, '-o', imgDir + '/', ...todo.slice(i, i + 50).map((f) => join(images, f))])
  }
} else {
  // Hard links: same disk, no space, and ODM never writes into images/.
  for (const f of files) if (!have.has(f)) await link(join(images, f), join(imgDir, f))
}

// geo.txt for a full run when the positions live in a reference file (PUTI, UseGeo).
const ref = cfg.reference ? await loadReference(cfg.reference) : null
const extra = []
if (mode === 'full' && !exif0.GPSLatitude && ref?.positions) {
  const byStem = new Map(files.map((f) => [stem(f), f]))
  const lines = ['EPSG:4326']
  for (const [s, p] of Object.entries(ref.positions))
    if (byStem.has(s)) lines.push(`${byStem.get(s)} ${p.lon} ${p.lat} ${p.alt}`)
  await writeFile(join(proj, 'geo.txt'), lines.join('\n') + '\n')
  extra.push('--geo', '/datasets/project/geo.txt')
  console.log(`== geo.txt: ${lines.length - 1} positions from the reference file`)
}

// ── run ─────────────────────────────────────────────────────────────────────────────
const odmArgs = [
  '--project-path',
  '/datasets',
  'project',
  '--max-concurrency',
  String(args.threads ?? 20),
  ...(mode === 'sfm' ? ['--end-with', 'opensfm'] : ['--dsm', '--pc-copc']),
  ...extra,
]
const digest = sh('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', dockerImage]).trim()
const version = sh('docker', ['run', '--rm', '--entrypoint', 'cat', dockerImage, '/code/VERSION']).trim()
const cname = `odm-${name}-${process.pid}`.replace(/[^a-zA-Z0-9_.-]/g, '-')
const runFile = join(ws, 'run.json')
const { seconds, peakMiB } = scoreOnly ? JSON.parse(await readFile(runFile, 'utf8')) : await runOdm()
async function runOdm() {
  console.log(`== docker ${dockerImage} ${odmArgs.join(' ')}`)
  const t0 = Date.now()
  const logLines = []
  let peakMiB = 0
  const proc = spawn('docker', ['run', '--rm', '--name', cname, '-v', `${ws}:/datasets`, dockerImage, ...odmArgs])
  const onData = (d) => {
    const s = d.toString()
    logLines.push(s)
    process.stdout.write(s)
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  // Peak memory: the container's cgroup usage, sampled every 2 s.
  const toMiB = (s) => {
    const m = /([\d.]+)\s*([KMGT]i?B)/.exec(s)
    if (!m) return 0
    return Number(m[1]) * { KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1 << 20, kB: 1 / 1000, MB: 1, GB: 1000 }[m[2]]
  }
  const sampler = setInterval(() => {
    const r = spawnSync('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}', cname], { encoding: 'utf8' })
    if (r.status === 0) peakMiB = Math.max(peakMiB, toMiB(r.stdout.split('/')[0]))
  }, 2000)
  const code = await new Promise((res) => proc.on('close', res))
  clearInterval(sampler)
  const seconds = (Date.now() - t0) / 1000
  await writeFile(join(ws, 'odm.log'), logLines.join(''))
  if (code !== 0) throw new Error(`ODM failed (exit ${code}); see ${join(ws, 'odm.log')}`)
  await writeFile(runFile, JSON.stringify({ seconds, peakMiB }))
  return { seconds, peakMiB }
}

// ── score ───────────────────────────────────────────────────────────────────────────
const recon = JSON.parse(await readFile(join(proj, 'opensfm/reconstruction.json'), 'utf8'))
const model = parseOpenSfm(recon)
// Scored against the reference file, or the ORIGINAL photos' EXIF GPS (the copies have none).
const { pc, positionSource } = await scoreCameraPositions(model, images, ref)
// ODM's log.json: one entry per stage with its wall time.
const odmLog = JSON.parse(await readFile(join(proj, 'log.json'), 'utf8').catch(() => '{}'))
const stageSeconds = Object.fromEntries(
  (odmLog.stages ?? []).map((st) => [
    st.name,
    Math.round(st.totalTime ?? (Date.parse(st.endTime) - Date.parse(st.startTime)) / 1000),
  ]),
)
const out = {
  name,
  config: args.config,
  odm: { version, image: digest, mode, args: odmArgs.join(' '), focalHint: needsFocal ? cfg.sensor.focal : null },
  images: files.length,
  registered: model.images.length,
  reconstructions: Array.isArray(recon) ? recon.length : 1,
  points: model.points.length,
  seconds: Math.round(seconds),
  stageSeconds,
  peakMemMiB: Math.round(peakMiB),
  positionCheck: pc,
  positionSource,
  stages: { recon: { model: benchModel(model) } },
}
await writeFile(join(ws, 'summary.json'), JSON.stringify(out, null, 2))
if (!args.keep && needsCopy && !scoreOnly) await rm(imgDir, { recursive: true })
const { stages: _omit, ...shown } = out
console.log(JSON.stringify(shown, null, 2))
console.log(`summary: ${join(ws, 'summary.json')}`)
