// Metashape reference run on a bench config's images: Metashape's sparse alignment at its
// own defaults (metashape_align.py), timed per stage with its peak memory, and scored with
// the SAME camera-position check the bench applies to WebSfM (refScore.mjs), so the tools
// sit side by side in docs/BENCHMARKS.md (TODO ▸ PAR-1 scoreboard).
//
//   node scripts/bench/metashape-ref.mjs --config scripts/bench/configs/<cfg>.json
//        [--ws <dir>]          workspace (default bench-out/metashape-<name>-<stamp>)
//        [--python <exe>]      an interpreter with the Metashape module
//                              (default $METASHAPE_PYTHON, else ~/miniconda3/envs/hist_env3)
//        [--name <label>]
//
// As in colmap-ref.mjs, the one choice that mirrors the WebSfM run is pairing: when the
// config uses position preselection, Metashape's reference preselection pairs by the
// photos' positions too. With the config's `recon.posePriors: false` the positions are
// switched off in Metashape's solve as well (it uses enabled camera references). The summary carries the
// camera model as `stages.recon.model`, so camera-check.mjs scores it against ETH3D's
// or COLMAP's cameras like a bench result. Run it alone, not beside a bench run, or both
// timings lie.
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadReference } from './reference.mjs'
import { parseColmapModel, readColmapModel } from '../../src/core/io/colmapModel.js'
import { scoreCameraPositions, benchModel } from './refScore.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
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
const cfg = args.config ? JSON.parse(await readFile(args.config, 'utf8')) : {}
const images = cfg.images
if (!images) throw new Error('config needs "images"')
const name = args.name ?? `metashape-${cfg.name ?? 'run'}`
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const ws = args.ws ? resolve(args.ws) : join(repo, 'bench-out', `${name}-${stamp}`)
await mkdir(ws, { recursive: true })
const python = args.python ?? process.env.METASHAPE_PYTHON ?? join(homedir(), 'miniconda3/envs/hist_env3/bin/python')
const preselect = cfg.match?.strategy === 'preselect'
const noPriors = cfg.recon?.posePriors === false

console.log(`== metashape_align.py on ${images}`)
const r = spawnSync(
  python,
  [
    join(here, 'metashape_align.py'),
    '--images',
    images,
    '--ws',
    ws,
    ...(preselect ? ['--preselect-reference'] : []),
    ...(noPriors ? ['--no-pose-priors'] : []),
  ],
  { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' }, encoding: 'utf8', maxBuffer: 1 << 30 },
)
await writeFile(join(ws, 'metashape.log'), (r.stdout ?? '') + (r.stderr ?? ''))
if (r.status !== 0) throw new Error(`metashape_align.py failed (exit ${r.status}); see ${join(ws, 'metashape.log')}`)
const ms = JSON.parse(await readFile(join(ws, 'metashape.json'), 'utf8'))

const txt = join(ws, 'colmap/sparse/0')
const files = Object.fromEntries(
  await Promise.all(
    ['cameras.txt', 'images.txt', 'points3D.txt'].map(async (f) => [f, await readFile(join(txt, f), 'utf8')]),
  ),
)
const model = readColmapModel(parseColmapModel(files))
const ref = await loadReference(cfg.reference)
const { pc, positionSource } = await scoreCameraPositions(model, images, ref)
const nFiles = (await readdir(images)).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).length

const out = {
  name,
  config: args.config ?? null,
  metashape: {
    version: ms.metashape,
    gpus: ms.gpus,
    settings: 'High (downscale 1), 40,000 key / 4,000 tie points, generic preselection',
    referencePreselection: ms.referencePreselection,
    posePriors: ms.posePriors,
  },
  images: nFiles,
  registered: model.images.length,
  points: model.points.length,
  pointsGe3: model.points.filter((p) => (p.views?.length ?? 0) >= 3).length,
  seconds: ms.seconds,
  peakRssMiB: ms.peakRssMiB,
  positionCheck: pc,
  positionSource,
  stages: { recon: { model: benchModel(model) } },
}
await writeFile(join(ws, 'summary.json'), JSON.stringify(out, null, 2))
const { stages: _omit, ...shown } = out
console.log(JSON.stringify(shown, null, 2))
console.log(`summary: ${join(ws, 'summary.json')}`)
