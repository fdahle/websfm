// Texture lab: rerun the mesh texture (core/products/texture/) in Node on a real
// project, in seconds instead of a browser pipeline run per change.
//
//   node scripts/bench/run-bench.mjs --config … (stages …,decimate,texturedump)
//   node scripts/bench/textureLab.mjs --dump bench-out/sb30 --out /tmp/lab [--opts '{"smoothness":1}'] [--pages] [--glb out.glb]
//
// The dump (bench `texturedump` stage) holds the mesh and every registered camera with
// its frame model; the photos are read from the dataset folder named in it and decoded
// with ffmpeg (cached as raw RGBA under --out). Lens, self-cal and film maps are built
// exactly as workers/ops/texture.js builds them; masks are not applied. Prints the run
// summary (seam step included); --pages writes the atlas pages as JPEG.

import { readFile, writeFile, mkdir, access } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { textureMesh } from '../../src/core/products/texture/texture.js'
import { makeSampleMap } from '../../src/core/sfm/displayFrame.js'
import { fisheyeCanvas } from '../../src/core/products/undistort.js'
import { hasDistortion } from '../../src/core/sfm/distortion.js'
import { fromScaledPx } from '../../src/core/sfm/geometry.js'
import { meshToGlbParts } from '../../src/core/products/exporters.js'
import { sampleRgbaBilinear } from '../../src/core/products/undistort.js'
import { joinParts } from '../../src/core/io/parts.js'

const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const dump = arg('dump'),
  out = arg('out', '/tmp/texture-lab')
const opts = JSON.parse(arg('opts', '{}'))
if (!dump) throw new Error('--dump <prefix of a texturedump> is required')
await mkdir(join(out, 'cache'), { recursive: true })

const meta = JSON.parse(await readFile(`${dump}.texturedump.json`, 'utf8'))
const bin = await readFile(`${dump}.texturedump.bin`)
const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength)
const nV = meta.nVerts,
  nT = meta.triangles
const mesh = {
  pos: new Float64Array(buf, 0, 3 * nV),
  idx: new Uint32Array(buf, 24 * nV, 3 * nT),
  col: meta.hasCol ? new Uint8Array(buf, 24 * nV + 12 * nT, 3 * nV) : null,
}

const views = meta.views
const coreViews = views.map((v) => {
  const frame = v.fiducial?.frame
  const canvas = !frame && !hasDistortion(v.selfCal) ? fisheyeCanvas(v.K, v.dist, v.width, v.height) : null
  return {
    R: v.R,
    t: v.t,
    K: v.K,
    width: frame?.width ?? v.width,
    height: frame?.height ?? v.height,
    rect: canvas ? { x0: -canvas.dx, y0: -canvas.dy, width: canvas.width, height: canvas.height } : undefined,
  }
})
const toPhoto = views.map((v) => makeSampleMap({ K: v.K, dist: v.dist, selfCal: v.selfCal, fiducial: v.fiducial }))

// A photo decoded to RGBA at w×h (ffmpeg), cached.
async function decode(v, w, h) {
  const file = join(out, 'cache', `${v.name}-${w}x${h}.rgba`)
  try {
    await access(file)
  } catch {
    const raw = execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-i',
        join(meta.images, v.name),
        '-vf',
        `scale=${w}:${h}:flags=area`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-',
      ],
      { maxBuffer: w * h * 4 + 1024 },
    )
    await writeFile(file, raw)
  }
  return new Uint8ClampedArray((await readFile(file)).buffer)
}

const hooks = {
  validLut: async (vi, grid) => {
    const v = views[vi],
      map = toPhoto[vi]
    if (!map) return null
    const lut = new Uint8Array(grid.width * grid.height)
    for (let gy = 0; gy < grid.height; gy++) {
      const py = grid.y0 + fromScaledPx(gy, grid.scale)
      for (let gx = 0; gx < grid.width; gx++) {
        const p = map(grid.x0 + fromScaledPx(gx, grid.scale), py)
        if (p.x >= -0.5 && p.y >= -0.5 && p.x <= v.width - 0.5 && p.y <= v.height - 0.5) lut[gy * grid.width + gx] = 1
      }
    }
    return lut
  },
  // The photo resampled into the z-buffer grid (as workers/ops/texture.js viewImage).
  viewImage: async (vi, grid) => {
    const v = views[vi],
      map = toPhoto[vi]
    const s = Math.min(1, grid.scale * 1.25),
      w = Math.round(v.width * s),
      h = Math.round(v.height * s)
    const src = await decode(v, w, h)
    const data = new Uint8ClampedArray(grid.width * grid.height * 4)
    for (let gy = 0; gy < grid.height; gy++) {
      const py = grid.y0 + fromScaledPx(gy, grid.scale)
      for (let gx = 0; gx < grid.width; gx++) {
        const p = map
          ? map(grid.x0 + fromScaledPx(gx, grid.scale), py)
          : { x: grid.x0 + fromScaledPx(gx, grid.scale), y: py }
        sampleRgbaBilinear(
          src,
          w,
          h,
          (p.x + 0.5) * (w / v.width) - 0.5,
          (p.y + 0.5) * (h / v.height) - 0.5,
          data,
          4 * (gy * grid.width + gx),
        )
      }
    }
    return { data }
  },
  loadPhoto: async (vi, scale) => {
    const v = views[vi]
    const want = Math.min(1, 2 * scale)
    const w = Math.round(v.width * want),
      h = Math.round(v.height * want)
    const data = await decode(v, w, h)
    const map = makeSampleMap({
      K: v.K,
      dist: v.dist,
      selfCal: v.selfCal,
      fiducial: v.fiducial,
      outScale: scale,
      srcScale: [w / v.width, h / v.height],
    })
    return { data, width: w, height: h, map }
  },
  onLog: (m) => console.log(m),
}

const t0 = performance.now()
const res = await textureMesh(mesh, coreViews, { pageSize: 4096, maxPages: 8, ...opts }, hooks)
console.log(`lab: ${((performance.now() - t0) / 1000).toFixed(1)} s`)
const { seams, gains, charts, pieces, pages, seenFaces, faces } = res.summary
console.log(JSON.stringify({ opts, seenFaces, faces, charts, pieces, pages, gains, seams }))
const jpeg = (p) =>
  execFileSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${p.width}x${p.height}`,
      '-i',
      '-',
      '-q:v',
      '3',
      '-f',
      'mjpeg',
      '-',
    ],
    { input: Buffer.from(p.data.buffer), maxBuffer: 1 << 28 },
  )
// --glb <file>: the textured mesh as GLB (pages as JPEG), for a viewer.
if (arg('glb')) {
  const pages = res.pages.map((p) => ({ bytes: new Uint8Array(jpeg(p)), type: 'image/jpeg' }))
  await writeFile(arg('glb'), joinParts(meshToGlbParts(res, { texture: { pages, groups: res.groups } })))
  console.log(`glb → ${arg('glb')}`)
}
if (process.argv.includes('--pages')) {
  for (let i = 0; i < res.pages.length; i++) {
    const p = res.pages[i],
      file = join(out, `page-${i}.jpg`)
    execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${p.width}x${p.height}`,
        '-i',
        '-',
        '-q:v',
        '3',
        file,
      ],
      { input: Buffer.from(p.data.buffer) },
    )
    console.log(`page ${i} → ${file}`)
  }
}
