// Bench config `hist`: a historical film / satellite frame block in the Grenoble
// benchmark layout (see README.md here), turned into what the bench page sets up.
//
//   "hist": {
//     "intrinsics": ".../camera_model_intrinsics.csv",  focal_length (mm), pixel_pitch (mm/px),
//                                                         principal_point_x/y_mm (y up)
//     "mask": ".../image_mask.tif",                      one for all images; keep class = the centre's
//     "maskPng": ".../websfm_eval/masks/cg.png",         where the app-convention PNG is cached
//     "masks": ".../masks",                              a folder of per-image masks, paired by name
//                                                         (Masks ▸ Import folder); TIFF is fine
//     "maskExisting": "merge",                           with "mask" too: add each file to the static mask
//     "footprints": ".../footprints.geojson",            approximate image footprints (polygons named by image)
//     "gcps": ".../gcp.csv",                             gcp_label, image_file_name, x, y (pixel-edge),
//                                                         x_map, y_map, elev, *_acc  (in cfg.crs)
//     "checkEvery": 4,                                   every 4th label (sorted) is a checkpoint; 0 = none
//     "noGcps": false,                                   true: no GCPs at all (pose-free, unreferenced)
//     "refDem": ".../CG_reference_dem_zoom.tif",         after the dem stage: score_dem.py
//     "python": "<interpreter with rasterio>"            default: the hist_env3 conda env
//   }
//
// The checkpoint choice (sorted labels, every Nth from the first) is the same as
// metashape_hist.py's, so the three tools are scored on the same points.
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { openSync, readSync, closeSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PY_DEFAULT = '/home/fdahle/miniconda3/envs/hist_env3/bin/python'

function csvRows(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const head = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [head[i], v.trim()])))
}

// Width/height from a baseline TIFF's first IFD (tags 256/257), without decoding it.
function tiffSize(path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1 << 16)
    readSync(fd, buf, 0, buf.length, 0)
    const le = buf.toString('latin1', 0, 2) === 'II'
    const ifd = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4)
    const ifdBuf = Buffer.alloc(4096)
    readSync(fd, ifdBuf, 0, ifdBuf.length, ifd)
    const v16 = (o) => (le ? ifdBuf.readUInt16LE(o) : ifdBuf.readUInt16BE(o))
    const v32 = (o) => (le ? ifdBuf.readUInt32LE(o) : ifdBuf.readUInt32BE(o))
    const n = v16(0)
    let w = null,
      h = null
    for (let i = 0; i < n; i++) {
      const e = 2 + 12 * i
      const tag = v16(e),
        type = v16(e + 2)
      const val = type === 3 ? v16(e + 8) : v32(e + 8)
      if (tag === 256) w = val
      if (tag === 257) h = val
    }
    return { w, h }
  } finally {
    closeSync(fd)
  }
}

export async function histSetup(h, imageNames) {
  const out = { sensor: null, maskDataUrl: null, maskFiles: null, gcps: null, checks: [], fiducials: null }
  if (h.masks) out.maskFiles = (await readdir(h.masks)).sort()
  if (h.intrinsics) {
    const r = csvRows(await readFile(h.intrinsics, 'utf8'))[0]
    const pitch = Number(r.pixel_pitch)
    out.sensor = { focal: Number(r.focal_length), focalUnit: 'mm', pixelSize: pitch }
    if (h.imagesDir && imageNames.length) {
      // Absolute pixel-centre principal point (sensor-table convention): the certificate's
      // offset from the frame centre (mm, y up) on a scan whose centre is the frame's.
      const { w, h: ht } = tiffSize(join(h.imagesDir, imageNames[0]))
      if (w && ht) {
        out.sensor.cx = w / 2 + Number(r.principal_point_x_mm || 0) / pitch - 0.5
        out.sensor.cy = ht / 2 - Number(r.principal_point_y_mm || 0) / pitch - 0.5
      }
    }
    if (h.sensor) Object.assign(out.sensor, h.sensor)
  }
  if (h.mask) {
    const png = h.maskPng ?? h.mask.replace(/\.tiff?$/i, '.app.png')
    if (!existsSync(png)) {
      await mkdir(dirname(png), { recursive: true })
      // App convention (core/mask.js): excluded pixels opaque, kept ones transparent.
      // The sites disagree on the convention (Casa Grande 1 = keep, Iceland 0 = keep and
      // 255 = border): the frame centre is always terrain, so its value names the kept class.
      const py =
        `import rasterio, numpy as np\nfrom PIL import Image\nr = rasterio.open(${JSON.stringify(h.mask)}).read(1)\n` +
        `m = r == r[r.shape[0] // 2, r.shape[1] // 2]\n` +
        `a = np.zeros(m.shape + (4,), np.uint8)\na[..., 3] = np.where(m, 0, 255)\nImage.fromarray(a, 'RGBA').save(${JSON.stringify(png)}, optimize=True)\n`
      const r = spawnSync(h.python ?? PY_DEFAULT, ['-c', py], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error(`mask conversion failed: ${r.stderr}`)
    }
    out.maskDataUrl = `data:image/png;base64,${(await readFile(png)).toString('base64')}`
  }
  // Film fiducials: the certificate from the intrinsics CSV (corner_* / midside_* mm,
  // y up) and the per-image marks from detected_fiducial_markers.csv.
  if (h.fiducials) {
    const SLOTS = {
      corner_top_left: 'corner-tl',
      corner_top_right: 'corner-tr',
      corner_bottom_right: 'corner-br',
      corner_bottom_left: 'corner-bl',
      midside_top: 'side-top',
      midside_right: 'side-right',
      midside_bottom: 'side-bottom',
      midside_left: 'side-left',
    }
    const r = csvRows(await readFile(h.intrinsics, 'utf8'))[0]
    const marks = []
    for (const [col, slot] of Object.entries(SLOTS)) {
      const x = Number(r[`${col}_x_mm`]),
        y = Number(r[`${col}_y_mm`])
      if (r[`${col}_x_mm`] !== '' && Number.isFinite(x) && Number.isFinite(y))
        marks.push({ id: `F${marks.length + 1}`, xMm: x, yMm: y, slot })
    }
    const provided = []
    for (const row of csvRows(await readFile(h.fiducials.csv, 'utf8'))) {
      for (const [col, slot] of Object.entries(SLOTS)) {
        const px = Number(row[`${col}_x`]),
          py = Number(row[`${col}_y`])
        if (row[`${col}_x`] !== '' && Number.isFinite(px) && Number.isFinite(py))
          provided.push({ imageName: row.image_id, slot, px, py })
      }
    }
    out.fiducials = {
      certificate: {
        focalMm: Number(r.focal_length),
        ppxMm: Number(r.principal_point_x_mm) || 0,
        ppyMm: Number(r.principal_point_y_mm) || 0,
        marks,
      },
      provided,
      mode: h.fiducials.mode ?? 'provided',
      positions: h.fiducials.positions ?? 'corners+sides',
      frameMask: h.fiducials.frameMask !== false,
    }
    // The scan pitch comes from the fiducial fit; the preprocessed-frame cx/cy do not apply.
    if (out.sensor) {
      delete out.sensor.cx
      delete out.sensor.cy
      delete out.sensor.pixelSize
    }
  }
  if (h.gcps && !h.noGcps) {
    const names = new Set(imageNames)
    const by = new Map()
    for (const r of csvRows(await readFile(h.gcps, 'utf8'))) {
      const label = r.gcp_label
      if (!by.has(label)) {
        by.set(label, {
          name: label,
          x: Number(r.x_map),
          y: Number(r.y_map),
          z: Number(r.elev),
          accuracyX: Number(r.x_map_acc) || 0.5,
          accuracyY: Number(r.y_map_acc) || 0.5,
          accuracyZ: Number(r.elev_acc) || 0.5,
          role: 'control',
          observations: [],
        })
      }
      if (names.has(r.image_file_name))
        by.get(label).observations.push({ imageName: r.image_file_name, px: Number(r.x), py: Number(r.y) })
    }
    const labels = [...by.keys()].sort()
    const every = Number(h.checkEvery ?? 4)
    if (every > 0)
      for (let i = 0; i < labels.length; i += every) {
        by.get(labels[i]).role = 'check'
        out.checks.push(labels[i])
      }
    out.gcps = labels.map((l) => by.get(l))
  }
  return out
}

export function scoreDem(file, ref, python = PY_DEFAULT) {
  const outJson = file.replace(/\.tif$/, '.score.json')
  const r = spawnSync(python, [join(HERE, 'score_dem.py'), file, ref, '--out', outJson], {
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
  if (r.status !== 0) return { error: (r.stderr || '').slice(-2000) }
  try {
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  } catch {
    return { error: r.stdout.slice(-500) }
  }
}
