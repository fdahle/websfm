// COLMAP reference run on a bench config's images: the same set through COLMAP's CLI
// (features → matching → mapper, optionally undistort → PatchMatch → fusion), timed per
// stage and scored with the SAME positionCheck the bench applies to websfm, so the two
// sit side by side in HANDOVER ▸ B-parity (plan-parity PAR-1).
//
//   node scripts/bench/colmap-ref.mjs --config scripts/bench/configs/<cfg>.json
//        [--colmap <colmap binary, default $COLMAP or PATH>] [--mapper mapper|global_mapper] [--dense]
//        [--denseMaxImageSize 2000] [--cameraModel SIMPLE_RADIAL] [--name <label>]
//        [--model <COLMAP model dir> --imagePath <dir>]   dense only, on a given model
//                                                         (e.g. ETH3D's ground-truth cameras)
//
// Defaults are COLMAP's own, except two choices that mirror the websfm run so the
// comparison is one of methods, not of setup: one shared camera per set
// (ImageReader.single_camera), and spatial matching with the config's neighbour count
// when the config uses websfm's position preselection (else exhaustive). COLMAP runs
// on the GPU (CUDA build); run it alone, not beside a bench run, or both timings lie.
// Writes bench-out/colmap-<name>-<stamp>/ (database, models, logs) and a JSON summary.
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import exifr from 'exifr'
import { loadReference } from './reference.mjs'
import { parseColmapModel, readColmapModel } from '../../src/core/io/colmapModel.js'
import { cameraPositionCheck, geodeticToEcef, makeEnuFrame } from '../../src/core/eval/positionCheck.js'
import { DatabaseSync } from 'node:sqlite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!a.startsWith('--')) continue
  const k = a.slice(2), v = process.argv[i + 1]
  if (v == null || v.startsWith('--')) args[k] = true
  else { args[k] = v; i++ }
}
const cfg = args.config ? JSON.parse(await readFile(args.config, 'utf8')) : {}
// The binary: --colmap, else $COLMAP, else `colmap` on PATH.
const colmap = args.colmap ?? process.env.COLMAP ?? 'colmap'
const name = args.name ?? `colmap-${cfg.name ?? 'run'}`
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const ws = join(repo, 'bench-out', `${name}-${stamp}`)
await mkdir(ws, { recursive: true })
const images = args.imagePath ?? cfg.images
if (!images) throw new Error('config needs "images" (or --imagePath)')
const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase()

const timings = {}
const env = { ...process.env, QT_QPA_PLATFORM: 'offscreen' }
function run(stage, cmd, opts) {
  const argv = [cmd, ...Object.entries(opts).flatMap(([k, v]) => [`--${k}`, String(v)])]
  console.log(`== ${stage}: colmap ${argv.join(' ')}`)
  const t0 = Date.now()
  const r = spawnSync(colmap, argv, { env, encoding: 'utf8', maxBuffer: 1 << 30 })
  timings[stage] = (Date.now() - t0) / 1000
  const log = (r.stdout ?? '') + (r.stderr ?? '')
  return writeFile(join(ws, `${stage}.log`), log).then(() => {
    console.log(`   ${timings[stage].toFixed(1)} s, exit ${r.status}`)
    if (r.status !== 0) throw new Error(`${stage} failed (exit ${r.status}); see ${join(ws, `${stage}.log`)}`)
    return log
  })
}

const db = join(ws, 'database.db')
const given = args.model ?? null
const sparseDir = join(ws, 'sparse')
const mapper = args.mapper ?? 'mapper'
const preselect = cfg.match?.strategy === 'preselect'
const ref = await loadReference(cfg.reference)
if (!given) {
await run('features', 'feature_extractor', {
  image_path: images, database_path: db,
  'ImageReader.single_camera': 1, 'ImageReader.camera_model': args.cameraModel ?? 'SIMPLE_RADIAL',
})
// The positions websfm's preselection pairs by (the config's reference file) become
// COLMAP's pose priors, so its spatial matcher pairs by the same thing: ENU metres
// around their centroid (coordinate_system 1 = CARTESIAN). Without a file COLMAP keeps
// its EXIF GPS. Priors only steer pairing here — `mapper` does not constrain by them.
if (preselect && ref?.positions) {
  const pos = Object.values(ref.positions)
  const o = pos.reduce((a, p) => ({ lat: a.lat + p.lat / pos.length, lon: a.lon + p.lon / pos.length, h: a.h + p.alt / pos.length }), { lat: 0, lon: 0, h: 0 })
  const toEnu = makeEnuFrame(o.lat, o.lon, o.h)
  const sql = new DatabaseSync(db)
  const set = sql.prepare('UPDATE pose_priors SET position = ?, position_covariance = ?, coordinate_system = 1 WHERE corr_data_id = ?')
  const cov = Buffer.from(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer)
  let n = 0
  for (const { image_id: id, name: nm } of sql.prepare('SELECT image_id, name FROM images').all()) {
    const p = ref.positions[stem(nm.split('/').pop())]
    if (!p) continue
    set.run(Buffer.from(new Float64Array(toEnu(geodeticToEcef(p.lat, p.lon, p.alt))).buffer), cov, id); n++
  }
  sql.close()
  console.log(`   pose priors from the reference file: ${n} image(s)`)
}
if (preselect) {
  await run('matching', 'spatial_matcher', { database_path: db, 'SpatialMatching.max_num_neighbors': cfg.match?.maxNeighbors ?? 50 })
} else {
  await run('matching', 'exhaustive_matcher', { database_path: db })
}
await mkdir(sparseDir, { recursive: true })
await run('mapper', mapper, { image_path: images, database_path: db, output_path: sparseDir })
}

// The model with the most registered images (the mapper may split into several).
const models = given ? [] : (await readdir(sparseDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
let best = null
for (const m of models) {
  const txt = join(ws, `txt-${m}`)
  await mkdir(txt, { recursive: true })
  await run(`convert-${m}`, 'model_converter', { input_path: join(sparseDir, m), output_path: txt, output_type: 'TXT' })
  const files = Object.fromEntries(await Promise.all(['cameras.txt', 'images.txt', 'points3D.txt']
    .map(async (f) => [f, await readFile(join(txt, f), 'utf8')])))
  const model = readColmapModel(parseColmapModel(files))
  if (!best || model.images.length > best.model.images.length) best = { id: m, dir: join(sparseDir, m), model }
}
if (given) {
  const files = Object.fromEntries(await Promise.all(['cameras.txt', 'images.txt', 'points3D.txt']
    .map(async (f) => [f, await readFile(join(given, f), 'utf8')])))
  best = { id: 'given', dir: given, model: readColmapModel(parseColmapModel(files)) }
}
if (!best) throw new Error('mapper produced no model')
const { model } = best
const nFiles = (await readdir(images)).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).length

// Camera centres against the reference positions (a survey file), else EXIF GPS —
// exactly the bench's choice (tests/bench/bench.js reconstruct()).
let positions = ref?.positions ? new Map(Object.entries(ref.positions)) : null
if (!positions) {
  positions = new Map()
  for (const im of model.images) {
    const g = await exifr.gps(join(images, im.name.split('/').pop())).catch(() => null)
    const alt = await exifr.parse(join(images, im.name.split('/').pop()), ['GPSAltitude', 'GPSAltitudeRef']).catch(() => null)
    if (g && Number.isFinite(g.latitude) && alt?.GPSAltitude != null) {
      positions.set(stem(im.name.split('/').pop()), { lat: g.latitude, lon: g.longitude, alt: (alt.GPSAltitudeRef === 1 ? -1 : 1) * alt.GPSAltitude })
    }
  }
}
const cams = new Map(model.images.map((im) => [stem(im.name.split('/').pop()), { R: im.R, t: im.t }]))
const pc = cameraPositionCheck(cams, positions, { leverArm: ref?.leverArm ?? null })
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4)
const ge3 = model.points.filter((p) => (p.track?.length ?? p.views?.length ?? 0) >= 3).length

let dense = null
if (args.dense) {
  const dd = join(ws, 'dense')
  const maxSize = Number(args.denseMaxImageSize ?? 2000)
  // Undistort at full size and let PatchMatch downscale: the undistorter's max_image_size
  // rescales the images but, for an already-undistorted PINHOLE model (ETH3D), writes the
  // full-size camera, and PatchMatch then aborts on the size mismatch.
  await run('undistort', 'image_undistorter', { image_path: images, input_path: best.dir, output_path: dd })
  await run('patchmatch', 'patch_match_stereo', { workspace_path: dd, 'PatchMatchStereo.geom_consistency': 1, 'PatchMatchStereo.max_image_size': maxSize })
  const ply = join(dd, 'fused.ply')
  await run('fusion', 'stereo_fusion', { workspace_path: dd, output_path: ply })
  // Vertex count from the PLY header (the file itself can be GBs).
  const fd = openSync(ply, 'r'), buf = Buffer.alloc(4096)
  readSync(fd, buf, 0, 4096, 0); closeSync(fd)
  const m = /element vertex (\d+)/.exec(buf.toString('latin1'))
  dense = { points: m ? Number(m[1]) : null, maxImageSize: maxSize, ply: ply.split('\\').join('/'), bytes: (await stat(ply)).size }
}

const out = {
  name, config: args.config ?? null, colmap: { exe: colmap, mapper, cameraModel: args.cameraModel ?? 'SIMPLE_RADIAL',
    matcher: preselect ? `spatial (${cfg.match?.maxNeighbors ?? 50} neighbours)` : 'exhaustive' },
  images: nFiles, registered: model.images.length, models: models.length, points: model.points.length, pointsGe3: ge3,
  seconds: { ...timings, sfmTotal: (timings.features ?? 0) + (timings.matching ?? 0) + (timings.mapper ?? 0) },
  positionCheck: pc && { count: pc.count, scale: r4(pc.scale), rms3d: r4(pc.rms3d), rmsH: r4(pc.rmsH), rmsV: r4(pc.rmsV),
    medianH: r4(pc.medianH), p95H: r4(pc.p95H), maxH: r4(pc.maxH), medianV: r4(pc.medianV), p95V: r4(pc.p95V) },
  positionSource: ref?.positions ? 'reference file' : 'EXIF GPS',
  dense,
}
await writeFile(join(ws, 'summary.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
console.log(`summary: ${join(ws, 'summary.json')}`)
