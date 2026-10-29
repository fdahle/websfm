// A saved project of this format version, for tests/browser/project-format.spec.js:
// every later version must still open it (core/formatMigrations.js).
//
//   npm run fetch:examples                       # the Aukerman photos (CC0)
//   node scripts/fixtures/make-project-fixture.mjs <work dir>
//
// Five neighbouring Aukerman photos at 1,200 px (EXIF kept: GPS, focal length) run
// through the headless bench: detect, match, sparse, georeference from the camera
// positions, depth maps at 128 px, dense cloud, DEM, orthophoto, mesh, two markers and
// a scale bar, then a project export. The descriptors are dropped from the file to
// keep it small (only matching reads them). Writes
// tests/fixtures/projects/v<PROJECT_FORMAT_VERSION>/aukerman-5.websfm and, beside it,
// expected.json: what the opened project must hold.
//
// Needs ffmpeg and exiftool. The work dir holds the bench's browser profile: put it on
// a real disk, not /tmp.
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { PROJECT_FORMAT_VERSION } from '../../src/core/projectFormat.js'

const repo = resolve(new URL('../..', import.meta.url).pathname)
const work = process.argv[2] && resolve(process.argv[2])
if (!work) {
  console.error('usage: node scripts/fixtures/make-project-fixture.mjs <work dir>')
  process.exit(1)
}

// One photo and its four nearest by GPS: two flight lines, so every pair overlaps.
const PHOTOS = ['DSC00292', 'DSC00298', 'DSC00306', 'DSC00308', 'DSC00309']
const source = join(repo, 'public/examples/aukerman')
const images = join(work, 'images')
await rm(work, { recursive: true, force: true })
await mkdir(images, { recursive: true })
for (const p of PHOTOS) {
  const from = join(source, `${p}.JPG`),
    to = join(images, `${p}.JPG`)
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', from, '-vf', 'scale=1200:900', '-q:v', '5', to])
  execFileSync('exiftool', [
    '-q',
    '-overwrite_original',
    '-TagsFromFile',
    from,
    '-all:all',
    '-ThumbnailImage=',
    '-ExifImageWidth=1200',
    '-ExifImageHeight=900',
    to,
  ])
}

const config = {
  'name': 'project-fixture',
  images,
  'out': join(work, 'out'),
  'sceneType': 'aerial',
  'crs': 'EPSG:32617',
  'port': 4187,
  'detect': { maxKeypoints: 1500 },
  'depth': { maxDim: 128 },
  'mesh': { depth: 6 },
  'stages': 'detect,match,recon,georef,depth,dense,dem,ortho,mesh,scalebar,export:project',
  'export:project': { kind: 'project', settings: { includeDerived: true } },
}
const configPath = join(work, 'fixture.json')
await writeFile(configPath, JSON.stringify(config, null, 1))
execFileSync('node', [join(repo, 'scripts/bench/run-bench.mjs'), '--config', configPath], {
  cwd: repo,
  stdio: 'inherit',
})

const result = JSON.parse(await readFile(join(work, 'out.json'), 'utf8'))
const s = result.stages
for (const stage of ['recon', 'georef', 'depth', 'dense', 'dem', 'ortho', 'mesh', 'scalebar']) {
  if (!s[stage]) throw new Error(`the bench run has no ${stage} stage`)
}
if (s.recon.cameras !== PHOTOS.length) throw new Error(`only ${s.recon.cameras} of ${PHOTOS.length} cameras`)
if (!s.georef.ok) throw new Error('the georeference failed')

const archive = unzipSync(new Uint8Array(await readFile(join(work, 'out.project.project-fixture.websfm'))))
const kept = { 'manifest.json': [archive['manifest.json'], { level: 9 }] }
for (const [name, bytes] of Object.entries(archive)) {
  if (name === 'manifest.json' || name.startsWith('descriptors/')) continue
  kept[name] = [bytes, { level: name.endsWith('.json') ? 9 : 0 }]
}
const project = JSON.parse(new TextDecoder().decode(archive['project.json']))
if (project.formatVersion !== PROJECT_FORMAT_VERSION) {
  throw new Error(`the export is format ${project.formatVersion}, this code writes ${PROJECT_FORMAT_VERSION}`)
}

const dir = join(repo, `tests/fixtures/projects/v${PROJECT_FORMAT_VERSION}`)
await mkdir(dir, { recursive: true })
const file = zipSync(kept)
await writeFile(join(dir, 'aukerman-5.websfm'), file)
const expected = {
  formatVersion: PROJECT_FORMAT_VERSION,
  appVersion: result.appVersion ?? JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version,
  crs: config.crs,
  images: PHOTOS.length,
  cameras: s.recon.cameras,
  sparsePoints: s.recon.points,
  densePoints: s.dense.points,
  depthMaps: s.depth.depthMaps,
  meshTriangles: s.mesh.triangles,
  dem: { width: s.dem.width, height: s.dem.height },
  ortho: { width: s.ortho.width, height: s.ortho.height },
  markers: 2,
  scaleBars: 1,
  poses: PHOTOS.length,
}
await writeFile(join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
console.log(`${join(dir, 'aukerman-5.websfm')}: ${(file.byteLength / 1024 ** 2).toFixed(2)} MiB`)
console.log(JSON.stringify(expected))
