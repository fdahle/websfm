// COLMAP reference run on a bench config's images: the same set through COLMAP's CLI
// (features → matching → mapper, optionally undistort → PatchMatch → fusion), timed per
// stage and scored with the SAME positionCheck the bench applies to websfm, so the two
// sit side by side in HANDOVER ▸ B-parity (plan-parity PAR-1).
//
//   node scripts/bench/colmap-ref.mjs --config scripts/bench/configs/<cfg>.json
//        [--colmap <colmap binary, default $COLMAP or PATH>] [--mapper mapper|global_mapper] [--dense]
//        [--denseMaxImageSize 2000] [--cameraModel SIMPLE_RADIAL] [--name <label>]
//        [--model <COLMAP model dir> --imagePath <dir>]   dense only, on a given model
//        [--ws <dir>]                                       workspace (default bench-out/<name>-<stamp>)
//                                                         (e.g. ETH3D's ground-truth cameras)
//
// Defaults are COLMAP's own, except two choices that mirror the websfm run so the
// comparison is one of methods, not of setup: one shared camera per set when every photo
// has the same size (ImageReader.single_camera; ETH3D's undistorted photos differ, and a
// shared camera would drop all but those of the first size), and spatial matching with the config's neighbour count
// when the config uses websfm's position preselection (else exhaustive). COLMAP runs
// on the GPU (CUDA build); run it alone, not beside a bench run, or both timings lie.
// Writes bench-out/colmap-<name>-<stamp>/ (database, models, logs) and a JSON summary.
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { openSync, readSync, closeSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadReference } from './reference.mjs'
import { parseColmapModel, readColmapModel } from '../../src/core/io/colmapModel.js'
import { geodeticToEcef, makeEnuFrame } from '../../src/core/eval/positionCheck.js'
import { scoreCameraPositions, benchModel, stem } from './refScore.mjs'
import { DatabaseSync } from 'node:sqlite'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
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
// The binary: --colmap, else $COLMAP, else `colmap` on PATH.
const colmap = args.colmap ?? process.env.COLMAP ?? 'colmap'
const name = args.name ?? `colmap-${cfg.name ?? 'run'}`
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
// `--ws <dir>`: write the workspace there instead (dense workspaces are GBs; keep them off the SSD).
const ws = args.ws ? resolve(args.ws) : join(repo, 'bench-out', `${name}-${stamp}`)
await mkdir(ws, { recursive: true })
const images = args.imagePath ?? cfg.images
if (!images) throw new Error('config needs "images" (or --imagePath)')

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
// Width × height from a JPEG's frame header (null for anything else or a broken file).
async function jpegSize(file) {
  const b = await readFile(file)
  if (b[0] !== 0xff || b[1] !== 0xd8) return null
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null
    const m = b[i + 1]
    const len = b.readUInt16BE(i + 2)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
      return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`
    i += 2 + len
  }
  return null
}
// One shared camera, as websfm groups one camera's photos, unless the sizes differ (a JPEG
// set whose sizes can be read and are not all equal); then COLMAP's own default, one each.
async function oneSize(dir) {
  const files = (await readdir(dir)).filter((f) => /\.jpe?g$/i.test(f))
  if (!files.length) return true
  const sizes = new Set(await Promise.all(files.map((f) => jpegSize(join(dir, f)))))
  return sizes.size === 1 || sizes.has(null)
}

if (!given) {
  const shared = await oneSize(images)
  if (!shared) console.log('   photos of different sizes: one COLMAP camera per photo')
  await run('features', 'feature_extractor', {
    'image_path': images,
    'database_path': db,
    'ImageReader.single_camera': shared ? 1 : 0,
    'ImageReader.camera_model': args.cameraModel ?? 'SIMPLE_RADIAL',
  })
  // The positions websfm's preselection pairs by (the config's reference file) become
  // COLMAP's pose priors, so its spatial matcher pairs by the same thing: ENU metres
  // around their centroid (coordinate_system 1 = CARTESIAN). Without a file COLMAP keeps
  // its EXIF GPS. Priors only steer pairing here — `mapper` does not constrain by them.
  if (preselect && ref?.positions) {
    const pos = Object.values(ref.positions)
    const o = pos.reduce(
      (a, p) => ({ lat: a.lat + p.lat / pos.length, lon: a.lon + p.lon / pos.length, h: a.h + p.alt / pos.length }),
      { lat: 0, lon: 0, h: 0 },
    )
    const toEnu = makeEnuFrame(o.lat, o.lon, o.h)
    const sql = new DatabaseSync(db)
    const set = sql.prepare(
      'UPDATE pose_priors SET position = ?, position_covariance = ?, coordinate_system = 1 WHERE corr_data_id = ?',
    )
    const cov = Buffer.from(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer)
    let n = 0
    for (const { image_id: id, name: nm } of sql.prepare('SELECT image_id, name FROM images').all()) {
      const p = ref.positions[stem(nm.split('/').pop())]
      if (!p) continue
      set.run(Buffer.from(new Float64Array(toEnu(geodeticToEcef(p.lat, p.lon, p.alt))).buffer), cov, id)
      n++
    }
    sql.close()
    console.log(`   pose priors from the reference file: ${n} image(s)`)
  }
  if (preselect) {
    await run('matching', 'spatial_matcher', {
      'database_path': db,
      'SpatialMatching.max_num_neighbors': cfg.match?.maxNeighbors ?? 50,
    })
  } else {
    await run('matching', 'exhaustive_matcher', { database_path: db })
  }
  await mkdir(sparseDir, { recursive: true })
  await run('mapper', mapper, { image_path: images, database_path: db, output_path: sparseDir })
}

// The model with the most registered images (the mapper may split into several).
const models = given
  ? []
  : (await readdir(sparseDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
let best = null
for (const m of models) {
  const txt = join(ws, `txt-${m}`)
  await mkdir(txt, { recursive: true })
  await run(`convert-${m}`, 'model_converter', { input_path: join(sparseDir, m), output_path: txt, output_type: 'TXT' })
  const files = Object.fromEntries(
    await Promise.all(
      ['cameras.txt', 'images.txt', 'points3D.txt'].map(async (f) => [f, await readFile(join(txt, f), 'utf8')]),
    ),
  )
  const model = readColmapModel(parseColmapModel(files))
  if (!best || model.images.length > best.model.images.length) best = { id: m, dir: join(sparseDir, m), model }
}
if (given) {
  const files = Object.fromEntries(
    await Promise.all(
      ['cameras.txt', 'images.txt', 'points3D.txt'].map(async (f) => [f, await readFile(join(given, f), 'utf8')]),
    ),
  )
  best = { id: 'given', dir: given, model: readColmapModel(parseColmapModel(files)) }
}
if (!best) throw new Error('mapper produced no model')
const { model } = best
const nFiles = (await readdir(images)).filter((f) => /\.(jpe?g|png|tiff?)$/i.test(f)).length

const { pc, positionSource } = await scoreCameraPositions(model, images, ref)
const ge3 = model.points.filter((p) => (p.track?.length ?? p.views?.length ?? 0) >= 3).length

let dense = null
if (args.dense) {
  const dd = join(ws, 'dense')
  const maxSize = Number(args.denseMaxImageSize ?? 2000)
  // Undistort at full size and let PatchMatch downscale: the undistorter's max_image_size
  // rescales the images but, for an already-undistorted PINHOLE model (ETH3D), writes the
  // full-size camera, and PatchMatch then aborts on the size mismatch.
  await run('undistort', 'image_undistorter', { image_path: images, input_path: best.dir, output_path: dd })
  await run('patchmatch', 'patch_match_stereo', {
    'workspace_path': dd,
    'PatchMatchStereo.geom_consistency': 1,
    'PatchMatchStereo.max_image_size': maxSize,
  })
  const ply = join(dd, 'fused.ply')
  await run('fusion', 'stereo_fusion', { workspace_path: dd, output_path: ply })
  // Vertex count from the PLY header (the file itself can be GBs).
  const fd = openSync(ply, 'r'),
    buf = Buffer.alloc(4096)
  readSync(fd, buf, 0, 4096, 0)
  closeSync(fd)
  const m = /element vertex (\d+)/.exec(buf.toString('latin1'))
  dense = {
    points: m ? Number(m[1]) : null,
    maxImageSize: maxSize,
    ply: ply.split('\\').join('/'),
    bytes: (await stat(ply)).size,
  }
}

const out = {
  name,
  config: args.config ?? null,
  colmap: {
    exe: colmap,
    mapper,
    cameraModel: args.cameraModel ?? 'SIMPLE_RADIAL',
    matcher: preselect ? `spatial (${cfg.match?.maxNeighbors ?? 50} neighbours)` : 'exhaustive',
  },
  images: nFiles,
  registered: model.images.length,
  models: models.length,
  points: model.points.length,
  pointsGe3: ge3,
  seconds: { ...timings, sfmTotal: (timings.features ?? 0) + (timings.matching ?? 0) + (timings.mapper ?? 0) },
  positionCheck: pc,
  positionSource,
  stages: { recon: { model: benchModel(model) } },
  dense,
}
await writeFile(join(ws, 'summary.json'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
console.log(`summary: ${join(ws, 'summary.json')}`)
