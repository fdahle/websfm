// Point-cloud / mesh file import: format sniffing, parser dispatch, and the
// user-chosen import transform (unit scale, up-axis, subsample). Pure — bytes
// and flat arrays only; the worker op (workers/ops/io.js) and the import modal
// both call in here. Coordinates import VERBATIM into the current frame — no
// CRS reprojection (polar reprojection of arbitrary clouds is out of scope).

import { parsePly } from './ply.js'
import { parseLas } from './las.js'
import { parseXyzText } from './cloudText.js'
import { prepareCloudForExport } from '../products/exporters.js'

// Cheap binary-magic sniff over the first bytes (no text decode — a 500 MB LAS
// must not be decoded as a string). Falls back to the extension for text-ish
// formats. Returns 'ply' | 'las' | 'text' | null (null = not a cloud file).
export function sniffCloudFormat(bytes, name = '') {
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (head.length >= 4) {
    const magic = String.fromCharCode(head[0], head[1], head[2], head[3])
    if (magic === 'LASF') return 'las'
    if (magic.startsWith('ply') && (head[3] === 0x0a || head[3] === 0x0d)) return 'ply'
  }
  const ext = String(name).split('.').pop()?.toLowerCase()
  if (ext === 'ply') return 'ply'
  if (ext === 'las' || ext === 'laz') return 'las' // parseLas rejects LAZ with a clear error
  if (ext === 'xyz' || ext === 'pts' || ext === 'txt') return 'text'
  return null
}

// True when the leading rows of a text file read as bare numeric x y z [+ rgb /
// intensity+rgb] — the signal that a dropped .txt is a point cloud rather than a
// labelled GCP/pose table. Only 3 or 6–7 column layouts qualify: a 4-column
// all-numeric row is more plausibly "numeric-name x y z" (a GCP/pose list),
// which must keep flowing to the delimited-text detector / user chooser.
export function looksLikeXyzText(text, minRows = 2) {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')).slice(0, 5)
  if (lines.length < minRows) return false
  return lines.every((l) => {
    const tok = l.split(/[\s,;]+/)
    return (tok.length === 3 || tok.length === 6 || tok.length === 7)
      && tok.every((t) => t !== '' && Number.isFinite(Number(t)))
  })
}

// Dispatch a cloud/mesh file to its parser. Returns the parser's flat shape
// (cloud { count, pos, col?, nrm? } or mesh { nVerts, count, pos, idx, col? }).
export function parseCloudFile(buffer, name = '', { onLog } = {}) {
  const fmt = sniffCloudFormat(buffer, name)
  if (!fmt) throw new Error(`Unrecognized point-cloud format: ${name || '(unnamed file)'}`)
  if (fmt === 'ply') return parsePly(buffer, { onLog })
  if (fmt === 'las') return parseLas(buffer, { onLog })
  const text = new TextDecoder().decode(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer))
  return parseXyzText(text, { onLog })
}

// Basic stats for the import modal: point/face counts, bbox, carried attributes.
export function cloudStats(parsed) {
  const n = parsed.nVerts ?? parsed.count ?? 0
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  const pos = parsed.pos
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0 }
  return {
    points: parsed.idx ? parsed.nVerts : parsed.count,
    faces: parsed.idx ? parsed.count : 0,
    hasColor: !!parsed.col,
    hasNormals: !!parsed.nrm,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  }
}

// Apply the modal's import settings to a parsed cloud/mesh. `unitScale`
// multiplies coordinates; `swapYZ` converts a Y-up source to Z-up via a proper
// +90° rotation about X — (x, y, z) → (x, −z, y) — which preserves handedness
// (a plain axis swap would mirror the model). Normals get the same rotation;
// `subsampleCell` (world units, after scaling) voxel-merges clouds — it is
// ignored for meshes (faces index vertices) and drops normals when applied.
export function applyImportTransform(parsed, { unitScale = 1, swapYZ = false, subsampleCell = 0, onLog } = {}) {
  let out = parsed
  const n = parsed.nVerts ?? parsed.count ?? 0
  if ((unitScale !== 1 && unitScale > 0) || swapYZ) {
    const pos = new Float64Array(n * 3)
    const s = unitScale > 0 ? unitScale : 1
    for (let i = 0; i < n; i++) {
      const x = parsed.pos[i * 3] * s, y = parsed.pos[i * 3 + 1] * s, z = parsed.pos[i * 3 + 2] * s
      if (swapYZ) { pos[i * 3] = x; pos[i * 3 + 1] = -z; pos[i * 3 + 2] = y }
      else { pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z }
    }
    let nrm = parsed.nrm
    if (nrm && swapYZ) {
      const rn = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) {
        rn[i * 3] = nrm[i * 3]; rn[i * 3 + 1] = -nrm[i * 3 + 2]; rn[i * 3 + 2] = nrm[i * 3 + 1]
      }
      nrm = rn
    }
    out = { ...parsed, pos, ...(nrm ? { nrm } : {}) }
    onLog?.(`Import transform: ×${s}${swapYZ ? ', Y-up → Z-up' : ''}`, 'info', 'Import')
  }
  if (subsampleCell > 0 && !parsed.idx) {
    out = prepareCloudForExport(out, { cell: subsampleCell, onLog })
  }
  return out
}
