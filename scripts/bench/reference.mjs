// Reference data for accuracy checks: camera positions, GCPs and their image marks,
// loaded on the node side and handed to the bench page as plain JSON.
//
//   "reference": {
//     "cameras":   "<tsv: file lat lon h …>",           e.g. Metadata/Cameras_WGS84.txt
//     "gcps":      "<tsv: name lat lon h>",             e.g. Metadata/GCPs_WGS84.txt
//     "leverArm":  "<GNSS_offset.txt>" | [x, y, z],    antenna offset, m (file: Metashape axes; array: OpenCV axes)
//     "metashape": "<Project.files dir>",               GCP image marks (markers)
//     "markOffsetPx": 0,                                added to every mark (convention tests)
//     "markOffsetsPx": [-0.5],                          extra offsets scored on the SAME model
//     "excludeGcps": ["19"]                             labels kept out of the checkpoint RMS
//     "gcpOverrides": { "19": [lat, lon, h] }          replaces a file line (a known transcription
//                                                       or conversion slip); scoring only
//   }
//
// Checkpoints never enter the solve, so `markOffsetsPx` re-scores one reconstruction
// at several mark conventions (pixel-edge vs pixel-centre) without re-running SfM.
// A variant's `recon.leverArm: true` also hands `leverArm` to the solve (every
// sensor's gnssLeverArm); otherwise it is used only to evaluate camera positions.
//
// WGS84 geodetic with ellipsoidal heights throughout; positionCheck.js works in a local
// ENU frame, so no projection is involved.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'

const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase()

// Tab-separated when the line has tabs (a date column may contain a space), else any
// whitespace / comma / semicolon.
function parseTable(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(l.includes('\t') ? /\t/ : /[,; ]+/).map((c) => c.trim()).filter(Boolean))
}

async function readZipEntry(path, entry) {
  const files = unzipSync(new Uint8Array(await readFile(path)))
  return strFromU8(files[entry])
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))

/** Metashape markers → { label: [{ image, px, py }] } (pixel-edge convention, like the app's clicks). */
async function metashapeMarks(dir) {
  const chunk = await readZipEntry(join(dir, '0', 'chunk.zip'), 'doc.xml')
  const frame = await readZipEntry(join(dir, '0', '0', 'frame.zip'), 'doc.xml')
  const camLabel = new Map([...chunk.matchAll(/<camera id="(\d+)"[^>]*label="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  const markerLabel = new Map([...chunk.matchAll(/<marker id="(\d+)" label="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  const out = {}
  for (const m of frame.matchAll(/<marker marker_id="(\d+)">([\s\S]*?)<\/marker>/g)) {
    const label = markerLabel.get(m[1])
    if (label == null) continue
    out[label] = [...m[2].matchAll(/<location [^>]*\/>/g)].map((l) => attrs(l[0]))
      .filter((a) => camLabel.has(a.camera_id))
      .map((a) => ({ image: camLabel.get(a.camera_id), px: Number(a.x), py: Number(a.y) }))
  }
  return out
}

export async function loadReference(ref) {
  if (!ref) return null
  const out = { positions: null, leverArm: null, gcps: null,
    // GCP labels whose reference is known bad (GeoScan's 19: its file line was never
    // converted out of the source datum, 1.6 m E / 3.1 m U; HANDOVER ▸ GeoScan datum);
    // they are reported but left out of the checkpoint RMS.
    excludeGcps: Array.isArray(ref.excludeGcps) ? ref.excludeGcps.map(String) : [],
    markOffsetsPx: Array.isArray(ref.markOffsetsPx) ? ref.markOffsetsPx.map(Number).filter(Number.isFinite) : [] }
  if (ref.cameras) {
    out.positions = {}
    // Optional per-camera standard deviations in metres: `sigmaColumns` = 0-based column
    // indices of [north, east, up] (GeoScan's Cameras_WGS84.txt: [8, 9, 10]). Without
    // them, imported poses get the app's 5 m default and barely constrain anything.
    const sc = ref.sigmaColumns
    for (const r of parseTable(await readFile(ref.cameras, 'utf8'))) {
      const [file, lat, lon, h] = r
      if (!(Number.isFinite(+lat) && Number.isFinite(+lon) && Number.isFinite(+h))) continue
      const pos = { lat: +lat, lon: +lon, alt: +h }
      if (sc) {
        const [sn, se, su] = sc.map((i) => Number(r[i]))
        if ([sn, se, su].every((v) => Number.isFinite(v) && v > 0)) Object.assign(pos, { sn, se, su })
      }
      out.positions[stem(file)] = pos
    }
  }
  // positionCheck.js wants the antenna in the OpenCV camera frame (x right, y down,
  // z forward). Metashape's GNSS offset is given with y up and z backward, so a
  // GNSS_offset.txt file converts as (x, −y, −z). Verified on the GeoScan set: with it,
  // Metashape's own cameras match the RTK file at 2.3 cm RMS; as given, 36 cm.
  if (Array.isArray(ref.leverArm)) out.leverArm = ref.leverArm
  else if (typeof ref.leverArm === 'string') {
    const t = await readFile(ref.leverArm, 'utf8')
    const v = [/X\s*=\s*(-?[\d.]+)/, /Y\s*=\s*(-?[\d.]+)/, /Z\s*=\s*(-?[\d.]+)/].map((re) => Number(t.match(re)?.[1]))
    if (v.every(Number.isFinite)) out.leverArm = [v[0], -v[1], -v[2]] // Metashape → OpenCV camera frame
  }
  if (ref.gcps) {
    const marks = ref.metashape ? await metashapeMarks(ref.metashape) : {}
    const off = Number(ref.markOffsetPx) || 0
    out.gcps = parseTable(await readFile(ref.gcps, 'utf8'))
      .filter((r) => r.length >= 4 && Number.isFinite(+r[1]))
      .map(([label, lat, lon, h]) => [label, ...(ref.gcpOverrides?.[label] ?? [lat, lon, h])])
      .map(([label, lat, lon, h]) => ({
        label, lat: +lat, lon: +lon, h: +h,
        marks: (marks[label] ?? []).map((m) => ({ image: stem(m.image), px: m.px + off, py: m.py + off })),
      }))
  }
  return out
}
