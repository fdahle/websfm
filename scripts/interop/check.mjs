// The interop check (scripts/interop/README.md): WebSfM's exports opened by the tools
// users open them in. Writes the exports (make-exports.mjs), then
//   GDAL   its COG validator (full check), CRS, geotransform, nodata, values (check_gdal.py)
//   PDAL   LAS, LAZ and COPC through readers.las, and the COPC through readers.copc:
//          point count, bounds, CRS, classes, 16-bit colour
//   COLMAP bundle_adjuster on the text and binary models: its initial cost is COLMAP's own
//          reprojection of our points into our cameras, so it is ~0 only when poses,
//          intrinsics and observations mean in COLMAP what they mean in WebSfM
// and fails (exit 1) on any difference from expected.json.
//
//   node scripts/interop/check.mjs [outDir]
//
// Tools: Docker images by default (pinned below); set GDAL_PYTHON (a python3 with the GDAL
// bindings), PDAL_BIN or COLMAP_BIN to use local installs instead. Docker needs no network
// inside the containers.
import { spawnSync } from 'node:child_process'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const out = resolve(process.argv[2] ?? 'bench-out/interop')
const GDAL_IMAGE = 'ghcr.io/osgeo/gdal:ubuntu-small-3.13.0'
// PDAL publishes no version tags: the digest of pdal/pdal:latest when this was written (2.10.2).
const PDAL_IMAGE = 'pdal/pdal@sha256:3e38c3feaa100878a285a8dba721dea3995f335f2b70e930382586279e32e064'
const COLMAP_IMAGE = 'colmap/colmap:latest'

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.error) throw r.error
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' }
}
const docker = (image, mounts, cmd) =>
  run('docker', ['run', '--rm', '--network', 'none', ...mounts.flatMap((m) => ['-v', m]), image, ...cmd])

const fails = []
const check = (cond, msg) => cond || fails.push(msg)

console.log('== exports')
const made = run(process.execPath, [join(here, 'make-exports.mjs'), out])
if (made.code !== 0) throw new Error(made.out)
const exp = JSON.parse(await readFile(join(out, 'expected.json'), 'utf8'))

// ── GDAL ────────────────────────────────────────────────────────────────────────────
console.log('== GDAL')
const g = process.env.GDAL_PYTHON
  ? run(process.env.GDAL_PYTHON, [join(here, 'check_gdal.py'), out])
  : docker(GDAL_IMAGE, [`${out}:/data:ro`, `${here}:/s:ro`], ['python3', '/s/check_gdal.py', '/data'])
console.log(g.out.trim())
check(g.code === 0, 'GDAL check failed (above)')

// ── PDAL ────────────────────────────────────────────────────────────────────────────
console.log('== PDAL')
const pdalInfo = (file, driver) => {
  const args = ['info', '--stats', '--metadata', '--enumerate', 'Classification', '--driver', driver]
  const r = process.env.PDAL_BIN
    ? run(process.env.PDAL_BIN, [...args, join(out, file)])
    : docker(PDAL_IMAGE, [`${out}:/data:ro`], ['pdal', ...args, `/data/${file}`])
  if (r.code !== 0) return { error: r.out.trim() }
  return JSON.parse(r.stdout)
}
const c = exp.cloud
const reads = [
  ['cloud.las', 'readers.las'],
  ['cloud.laz', 'readers.las'],
  ['cloud.copc.laz', 'readers.las'],
  ['cloud.copc.laz', 'readers.copc'],
]
for (const [file, driver] of reads) {
  const tag = `${file} (${driver})`
  const info = pdalInfo(file, driver)
  if (info.error) {
    check(false, `${tag}: PDAL could not read it: ${info.error}`)
    continue
  }
  // The header's count and bounds, and the same measured over the points PDAL decoded.
  const m = info.metadata
  const stat = Object.fromEntries(info.stats.statistic.map((x) => [x.name, x]))
  check(m.count === c.count, `${tag}: header says ${m.count} points, expected ${c.count}`)
  check(stat.X?.count === c.count, `${tag}: ${stat.X?.count} points decoded, expected ${c.count}`)
  for (const k of ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']) {
    const measured = stat[k.slice(3).toUpperCase()]?.[k.startsWith('min') ? 'minimum' : 'maximum']
    check(Math.abs(m[k] - c[k]) <= c.tolerance, `${tag}: header ${k} ${m[k]}, expected ${c[k]}`)
    check(Math.abs(measured - c[k]) <= c.tolerance, `${tag}: decoded ${k} ${measured}, expected ${c[k]}`)
  }
  const wkt = m.srs?.horizontal ?? ''
  check(new RegExp(`AUTHORITY\\["EPSG","${c.epsg}"\\]\\]$`).test(wkt), `${tag}: CRS is not EPSG:${c.epsg}`)
  check(
    JSON.stringify(stat.Classification?.values ?? []) === JSON.stringify(Object.keys(c.classes).map(Number)),
    `${tag}: classes ${JSON.stringify(stat.Classification?.values)}, expected ${Object.keys(c.classes)}`,
  )
  // LAS colour is 16-bit: an 8-bit 255 must arrive as 65535, not 255.
  check(stat.Red?.maximum === 65535, `${tag}: red maximum ${stat.Red?.maximum}, expected 65535 (16-bit colour)`)
  console.log(`  ${tag}: ${stat.X?.count} points, read by PDAL ${info.pdal_version}`)
}

// ── COLMAP ──────────────────────────────────────────────────────────────────────────
console.log('== COLMAP')
const tmp = join(out, 'colmap-ba')
for (const dir of exp.colmap.dirs) {
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  const r = process.env.COLMAP_BIN
    ? run(process.env.COLMAP_BIN, ['bundle_adjuster', '--input_path', join(out, dir), '--output_path', tmp])
    : docker(
        COLMAP_IMAGE,
        [`${out}:/data`],
        ['colmap', 'bundle_adjuster', '--input_path', `/data/${dir}`, '--output_path', '/data/colmap-ba'],
      )
  const residuals = Number(/Residuals\s*:\s*(\d+)/.exec(r.out)?.[1])
  const initial = Number(/Initial cost\s*:\s*([\d.eE+-]+)/.exec(r.out)?.[1])
  check(
    r.code === 0,
    `${dir}: COLMAP could not run bundle adjustment on it: ${r.out.trim().split('\n').slice(-3).join(' | ')}`,
  )
  // Two residuals (x, y) per observation.
  check(
    residuals === 2 * exp.colmap.observations,
    `${dir}: COLMAP sees ${residuals / 2} observations, expected ${exp.colmap.observations}`,
  )
  check(initial < 1e-6, `${dir}: COLMAP's reprojection of the exported model is ${initial} px, expected ~0`)
  console.log(`  ${dir}: ${residuals / 2} observations, COLMAP reprojection ${initial} px`)
}
await rm(tmp, { recursive: true, force: true })

if (fails.length) {
  console.log(`\nInterop check FAILED:\n  ${fails.join('\n  ')}`)
  process.exit(1)
}
console.log('\nInterop check passed: GDAL, PDAL and COLMAP read every export as written')
