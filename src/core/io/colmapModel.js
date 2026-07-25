// COLMAP sparse-model interop (text format): read/write the three files
// `cameras.txt`, `images.txt`, `points3D.txt`. Pure — text ↔ plain data, no
// DOM/store/wasm. The store/composable layer resolves uuid↔name and keypoint
// index↔pixel before calling `buildColmapModel` / after `readColmapModel`.
//
// Conventions that make this a near-1:1 mapping:
//   • COLMAP's qvec/tvec is **world-to-camera**, exactly websfm's `R`,`t`
//     (`R` row-major, `t=[x,y,z]`, camera centre `C=−Rᵀt`). Only R↔quaternion
//     conversion is needed (Hamilton, `[qw,qx,qy,qz]`, `qw ≥ 0`).
//   • websfm is pinhole throughout (distortion removed at ingest), so we export
//     the **PINHOLE** model (`fx fy cx cy`). On import, distortion coefficients
//     of SIMPLE_RADIAL/RADIAL/OPENCV cameras are read for fx/fy/cx/cy only and
//     the distortion terms are dropped (observations are treated as pinhole,
//     consistent with the rest of the pipeline) — the caller should warn.
//
// The intermediate "ColmapModel" mirrors the on-disk shape exactly so
// serialize→parse is a clean round-trip:
//   {
//     cameras:  [{ cameraId, model, width, height, params:[…] }],
//     images:   [{ imageId, q:[qw,qx,qy,qz], t:[tx,ty,tz], cameraId, name,
//                  points2D:[[x, y, point3dId]] }],   // point3dId = -1 if none
//     points3D: [{ point3dId, xyz:[x,y,z], rgb:[r,g,b], error,
//                  track:[[imageId, point2dIdx]] }],
//   }

import { makeNameResolver as makeIdResolver } from './nameMatch.js'

// ── Rotation ↔ quaternion (Hamilton, world-to-cam) ───────────────────────────

// Row-major R → normalized [qw, qx, qy, qz] with qw ≥ 0 (COLMAP convention).
export function rotationToQuat(R) {
  const [[r00, r01, r02], [r10, r11, r12], [r20, r21, r22]] = R
  const tr = r00 + r11 + r22
  let qw, qx, qy, qz
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2 // s = 4·qw
    qw = 0.25 * s
    qx = (r21 - r12) / s
    qy = (r02 - r20) / s
    qz = (r10 - r01) / s
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2 // s = 4·qx
    qw = (r21 - r12) / s
    qx = 0.25 * s
    qy = (r01 + r10) / s
    qz = (r02 + r20) / s
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2 // s = 4·qy
    qw = (r02 - r20) / s
    qx = (r01 + r10) / s
    qy = 0.25 * s
    qz = (r12 + r21) / s
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2 // s = 4·qz
    qw = (r10 - r01) / s
    qx = (r02 + r20) / s
    qy = (r12 + r21) / s
    qz = 0.25 * s
  }
  return normalizeQuatPositive([qw, qx, qy, qz])
}

// [qw, qx, qy, qz] → row-major rotation matrix (normalizes q first).
export function quatToRotation(q) {
  const [w, x, y, z] = normalizeQuat(q)
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

function normalizeQuat([w, x, y, z]) {
  const n = Math.hypot(w, x, y, z) || 1
  return [w / n, x / n, y / n, z / n]
}

function normalizeQuatPositive(q) {
  const [w, x, y, z] = normalizeQuat(q)
  return w < 0 ? [-w, -x, -y, -z] : [w, x, y, z]
}

// ── Camera model params ↔ intrinsics ─────────────────────────────────────────

// PARAMS layout per COLMAP model. Only the pinhole subset (fx, fy, cx, cy) is
// carried into websfm; trailing distortion terms are ignored on import.
const CAMERA_MODELS = {
  SIMPLE_PINHOLE: { params: ['f', 'cx', 'cy'] },
  PINHOLE: { params: ['fx', 'fy', 'cx', 'cy'] },
  SIMPLE_RADIAL: { params: ['f', 'cx', 'cy', 'k'] },
  RADIAL: { params: ['f', 'cx', 'cy', 'k1', 'k2'] },
  OPENCV: { params: ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2'] },
  FULL_OPENCV: { params: ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2', 'k3', 'k4', 'k5', 'k6'] },
}

// Extract { fx, fy, cx, cy, dropped } from a camera. `dropped` lists distortion
// param names present but not carried, so the caller can warn.
export function intrinsicsFromCamera({ model, params }) {
  const spec = CAMERA_MODELS[model]
  if (!spec) throw new Error(`Unsupported COLMAP camera model: ${model}`)
  const named = Object.fromEntries(spec.params.map((name, i) => [name, params[i]]))
  const fx = named.fx ?? named.f
  const fy = named.fy ?? named.f
  const dropped = spec.params.filter((n) => n !== 'fx' && n !== 'fy' && n !== 'f' && n !== 'cx' && n !== 'cy')
  return { fx, fy, cx: named.cx, cy: named.cy, dropped }
}

// ── Serialize (ColmapModel → { filename: text }) ─────────────────────────────

export function serializeColmapModel(model) {
  return {
    'cameras.txt': serializeCameras(model.cameras),
    'images.txt': serializeImages(model.images),
    'points3D.txt': serializePoints3D(model.points3D),
  }
}

function serializeCameras(cameras) {
  const head =
    '# Camera list with one line of data per camera:\n' +
    '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]\n' +
    `# Number of cameras: ${cameras.length}\n`
  const lines = cameras.map((c) =>
    [c.cameraId, c.model, c.width, c.height, ...c.params.map(fmt)].join(' '),
  )
  return head + lines.join('\n') + (lines.length ? '\n' : '')
}

function serializeImages(images) {
  const meanObs = images.length
    ? images.reduce((s, im) => s + im.points2D.length, 0) / images.length
    : 0
  const head =
    '# Image list with two lines of data per image:\n' +
    '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME\n' +
    '#   POINTS2D[] as (X, Y, POINT3D_ID)\n' +
    `# Number of images: ${images.length}, mean observations per image: ${fmt(meanObs)}\n`
  const lines = []
  for (const im of images) {
    lines.push([im.imageId, ...im.q.map(fmt), ...im.t.map(fmt), im.cameraId, im.name].join(' '))
    lines.push(im.points2D.map(([x, y, id]) => `${fmt(x)} ${fmt(y)} ${id}`).join(' '))
  }
  return head + lines.join('\n') + (lines.length ? '\n' : '')
}

function serializePoints3D(points) {
  const meanTrack = points.length
    ? points.reduce((s, p) => s + p.track.length, 0) / points.length
    : 0
  const head =
    '# 3D point list with one line of data per point:\n' +
    '#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)\n' +
    `# Number of points: ${points.length}, mean track length: ${fmt(meanTrack)}\n`
  const lines = points.map((p) => {
    const track = p.track.map(([imgId, idx]) => `${imgId} ${idx}`).join(' ')
    return [p.point3dId, ...p.xyz.map(fmt), ...p.rgb, fmt(p.error ?? -1), track]
      .join(' ')
      .trimEnd()
  })
  return head + lines.join('\n') + (lines.length ? '\n' : '')
}

// Full round-trippable double precision; integers stay integer-looking. Throws on a
// non-finite value rather than silently writing a plausible-looking 0 — a NaN pose or
// intrinsic is a real upstream bug and should fail the export loudly (repo convention:
// surface derived garbage, never bury it).
function fmt(v) {
  if (!Number.isFinite(v)) throw new Error(`COLMAP serialize: non-finite value ${v}`)
  return String(v)
}

// ── Parse ({ filename: text } → ColmapModel) ─────────────────────────────────

export function parseColmapModel(files) {
  return {
    cameras: parseCameras(files['cameras.txt'] ?? ''),
    images: parseImages(files['images.txt'] ?? ''),
    points3D: parsePoints3D(files['points3D.txt'] ?? ''),
  }
}

// Split into lines, dropping comment lines (leading '#') but KEEPING blank
// lines — an image with zero observations writes an empty points2D line that
// the pairing in `parseImages` must not lose.
function contentLines(text) {
  return text.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('#'))
}

function parseCameras(text) {
  const cameras = []
  for (const line of contentLines(text)) {
    const tok = line.trim().split(/\s+/).filter(Boolean)
    if (tok.length < 4) continue
    cameras.push({
      cameraId: Number(tok[0]),
      model: tok[1],
      width: Number(tok[2]),
      height: Number(tok[3]),
      params: tok.slice(4).map(Number),
    })
  }
  return cameras
}

function parseImages(text) {
  const lines = contentLines(text)
  const images = []
  let i = 0
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue } // skip blanks while seeking a header
    const tok = lines[i].trim().split(/\s+/).filter(Boolean)
    i++
    if (tok.length < 10) continue // not a valid header line
    // The very next line (blank or not) is this image's POINTS2D line.
    const pts2dLine = i < lines.length ? lines[i] : ''
    i++
    images.push({
      imageId: Number(tok[0]),
      q: [Number(tok[1]), Number(tok[2]), Number(tok[3]), Number(tok[4])],
      t: [Number(tok[5]), Number(tok[6]), Number(tok[7])],
      cameraId: Number(tok[8]),
      name: tok.slice(9).join(' '), // names may contain spaces
      points2D: parsePoints2D(pts2dLine),
    })
  }
  return images
}

function parsePoints2D(line) {
  const tok = line.trim().split(/\s+/).filter(Boolean)
  const out = []
  for (let k = 0; k + 3 <= tok.length; k += 3) {
    out.push([Number(tok[k]), Number(tok[k + 1]), Number(tok[k + 2])])
  }
  return out
}

function parsePoints3D(text) {
  const points = []
  for (const line of contentLines(text)) {
    const tok = line.trim().split(/\s+/).filter(Boolean)
    if (tok.length < 8) continue
    const track = []
    for (let k = 8; k + 1 < tok.length; k += 2) {
      track.push([Number(tok[k]), Number(tok[k + 1])])
    }
    points.push({
      point3dId: Number(tok[0]),
      xyz: [Number(tok[1]), Number(tok[2]), Number(tok[3])],
      rgb: [Number(tok[4]), Number(tok[5]), Number(tok[6])],
      error: Number(tok[7]),
      track,
    })
  }
  return points
}

// ── Binary format (LE) ↔ ColmapModel ─────────────────────────────────────────
// The binary sparse model mirrors the text one exactly (same ColmapModel struct,
// same adapters) — only the on-disk encoding differs. All fields little-endian.
// Layout (COLMAP src/base/reconstruction.cc):
//   cameras.bin:  u64 count; per camera: i32 camera_id, i32 model_id, u64 width,
//                 u64 height, f64 params×(model param count).
//   images.bin:   u64 count; per image: i32 image_id, f64 qw,qx,qy,qz,
//                 f64 tx,ty,tz, i32 camera_id, name bytes to '\0',
//                 u64 num_points2D, then per obs: f64 x, f64 y, i64 point3D_id.
//   points3D.bin: u64 count; per point: u64 point3D_id, f64 x,y,z, u8 r,g,b,
//                 f64 error, u64 track_len, then per elem: i32 image_id, i32 point2D_idx.

// COLMAP numeric model ids (we write PINHOLE=1; read the pinhole subset of the
// common models, warning on any that carry distortion). paramCount is what the
// binary stream carries, so the reader steps correctly even for models we don't
// fully support.
const MODEL_BY_ID = {
  0: { name: 'SIMPLE_PINHOLE', paramCount: 3 },
  1: { name: 'PINHOLE', paramCount: 4 },
  2: { name: 'SIMPLE_RADIAL', paramCount: 4 },
  3: { name: 'RADIAL', paramCount: 5 },
  4: { name: 'OPENCV', paramCount: 8 },
  5: { name: 'OPENCV_FISHEYE', paramCount: 8 },
  6: { name: 'FULL_OPENCV', paramCount: 12 },
  7: { name: 'FOV', paramCount: 5 },
  8: { name: 'SIMPLE_RADIAL_FISHEYE', paramCount: 4 },
  9: { name: 'RADIAL_FISHEYE', paramCount: 5 },
  10: { name: 'THIN_PRISM_FISHEYE', paramCount: 12 },
}
const ID_BY_MODEL = Object.fromEntries(Object.entries(MODEL_BY_ID).map(([id, m]) => [m.name, Number(id)]))

// A tiny growable little-endian byte writer (the models are small — hundreds of
// cameras, up to ~millions of points, but each record is a fixed handful of writes).
function makeWriter() {
  let buf = new ArrayBuffer(1 << 16)
  let dv = new DataView(buf)
  let len = 0
  const ensure = (extra) => {
    if (len + extra <= buf.byteLength) return
    let cap = buf.byteLength
    while (len + extra > cap) cap *= 2
    const nb = new ArrayBuffer(cap)
    new Uint8Array(nb).set(new Uint8Array(buf, 0, len))
    buf = nb; dv = new DataView(buf)
  }
  return {
    u8(v) { ensure(1); dv.setUint8(len, v); len += 1 },
    i32(v) { ensure(4); dv.setInt32(len, v, true); len += 4 },
    u64(v) { ensure(8); dv.setBigUint64(len, BigInt(v), true); len += 8 },
    i64(v) { ensure(8); dv.setBigInt64(len, BigInt(v), true); len += 8 },
    f64(v) { if (!Number.isFinite(v)) throw new Error(`COLMAP bin serialize: non-finite value ${v}`); ensure(8); dv.setFloat64(len, v, true); len += 8 },
    bytes(arr) { ensure(arr.length); new Uint8Array(buf).set(arr, len); len += arr.length },
    done() { return new Uint8Array(buf, 0, len) },
  }
}

function serializeCamerasBin(cameras) {
  const w = makeWriter()
  w.u64(cameras.length)
  for (const c of cameras) {
    const modelId = ID_BY_MODEL[c.model]
    if (modelId === undefined) throw new Error(`COLMAP bin serialize: unknown camera model ${c.model}`)
    w.i32(c.cameraId); w.i32(modelId); w.u64(c.width); w.u64(c.height)
    for (const p of c.params) w.f64(p)
  }
  return w.done()
}

function serializeImagesBin(images) {
  const w = makeWriter()
  w.u64(images.length)
  const enc = new TextEncoder()
  for (const im of images) {
    w.i32(im.imageId)
    for (const q of im.q) w.f64(q)
    for (const t of im.t) w.f64(t)
    w.i32(im.cameraId)
    w.bytes(enc.encode(im.name)); w.u8(0) // NUL-terminated name
    w.u64(im.points2D.length)
    for (const [x, y, id] of im.points2D) { w.f64(x); w.f64(y); w.i64(id) }
  }
  return w.done()
}

function serializePoints3DBin(points) {
  const w = makeWriter()
  w.u64(points.length)
  for (const p of points) {
    w.u64(p.point3dId)
    w.f64(p.xyz[0]); w.f64(p.xyz[1]); w.f64(p.xyz[2])
    w.u8(byte255(p.rgb[0])); w.u8(byte255(p.rgb[1])); w.u8(byte255(p.rgb[2]))
    w.f64(p.error ?? -1)
    w.u64(p.track.length)
    for (const [imageId, idx] of p.track) { w.i32(imageId); w.i32(idx) }
  }
  return w.done()
}

const byte255 = (v) => Math.max(0, Math.min(255, Math.round(v ?? 0)))

// Serialize a ColmapModel to the three .bin files ({ name: Uint8Array }).
export function serializeColmapModelBin(model) {
  return {
    'cameras.bin': serializeCamerasBin(model.cameras),
    'images.bin': serializeImagesBin(model.images),
    'points3D.bin': serializePoints3DBin(model.points3D),
  }
}

// A little-endian reader with a u64→Number guard (COLMAP counts fit Number in
// practice, but a corrupt/huge field must fail loudly, not silently truncate).
function makeReader(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 0
  const num64 = (big) => {
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('COLMAP bin: 64-bit value exceeds safe integer range')
    return Number(big)
  }
  return {
    get pos() { return p },
    get length() { return bytes.length },
    u8() { return bytes[p++] },
    i32() { const v = dv.getInt32(p, true); p += 4; return v },
    u64() { const v = num64(dv.getBigUint64(p, true)); p += 8; return v },
    i64() { const v = num64Signed(dv.getBigInt64(p, true)); p += 8; return v },
    f64() { const v = dv.getFloat64(p, true); p += 8; return v },
    strZ() { let s = ''; while (p < bytes.length && bytes[p] !== 0) s += String.fromCharCode(bytes[p++]); p++; return s },
  }
}
// point3D_id can be -1 (no track); keep the sign, guard the magnitude.
function num64Signed(big) {
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('COLMAP bin: signed 64-bit value exceeds safe integer range')
  }
  return Number(big)
}

function parseCamerasBin(buffer) {
  if (!buffer) return []
  const r = makeReader(buffer)
  const n = r.u64()
  const cameras = []
  for (let i = 0; i < n; i++) {
    const cameraId = r.i32()
    const modelId = r.i32()
    const width = r.u64()
    const height = r.u64()
    const spec = MODEL_BY_ID[modelId]
    if (!spec) throw new Error(`COLMAP bin: unknown camera model id ${modelId}`)
    const params = []
    for (let k = 0; k < spec.paramCount; k++) params.push(r.f64())
    cameras.push({ cameraId, model: spec.name, width, height, params })
  }
  return cameras
}

function parseImagesBin(buffer) {
  if (!buffer) return []
  const r = makeReader(buffer)
  const n = r.u64()
  const images = []
  for (let i = 0; i < n; i++) {
    const imageId = r.i32()
    const q = [r.f64(), r.f64(), r.f64(), r.f64()]
    const t = [r.f64(), r.f64(), r.f64()]
    const cameraId = r.i32()
    const name = r.strZ()
    const numPts = r.u64()
    const points2D = new Array(numPts)
    for (let k = 0; k < numPts; k++) points2D[k] = [r.f64(), r.f64(), r.i64()]
    images.push({ imageId, q, t, cameraId, name, points2D })
  }
  return images
}

function parsePoints3DBin(buffer) {
  if (!buffer) return []
  const r = makeReader(buffer)
  const n = r.u64()
  const points = []
  for (let i = 0; i < n; i++) {
    const point3dId = r.u64()
    const xyz = [r.f64(), r.f64(), r.f64()]
    const rgb = [r.u8(), r.u8(), r.u8()]
    const error = r.f64()
    const trackLen = r.u64()
    const track = new Array(trackLen)
    for (let k = 0; k < trackLen; k++) track[k] = [r.i32(), r.i32()]
    points.push({ point3dId, xyz, rgb, error, track })
  }
  return points
}

// Parse the three .bin files ({ 'cameras.bin': ArrayBuffer|Uint8Array, … }) into
// a ColmapModel — the same struct parseColmapModel yields, so readColmapModel /
// colmapToSparse consume it unchanged.
export function parseColmapModelBin(files) {
  return {
    cameras: parseCamerasBin(files['cameras.bin']),
    images: parseImagesBin(files['images.bin']),
    points3D: parsePoints3DBin(files['points3D.bin']),
  }
}

// ── websfm ↔ ColmapModel adapters (pure; caller injects resolved pixels) ─────

// Build a ColmapModel from websfm sparse data. One COLMAP camera per image
// (cameraId = imageId, 1-based). Inputs are plain data — the caller resolves
// each point's `views` to pixels first.
//   images: [{ uuid, name, width, height, K:{fx,fy,cx,cy}, R, t }]
//   points: [{ xyz:[x,y,z], color:[r,g,b], error?, views:[{ uuid, x, y }] }]
export function buildColmapModel({ images, points }) {
  const idOfUuid = new Map()
  const points2D = new Map() // uuid → [[x,y,point3dId]]
  images.forEach((im, i) => {
    idOfUuid.set(im.uuid, i + 1)
    points2D.set(im.uuid, [])
  })

  const points3D = points.map((p, i) => {
    const point3dId = i + 1
    const track = []
    for (const v of p.views ?? []) {
      const imageId = idOfUuid.get(v.uuid)
      if (imageId === undefined) continue // observation in an image we're not exporting
      const arr = points2D.get(v.uuid)
      const point2dIdx = arr.length
      arr.push([v.x, v.y, point3dId])
      track.push([imageId, point2dIdx])
    }
    return {
      point3dId,
      xyz: p.xyz,
      rgb: (p.color ?? [0, 0, 0]).map((c) => Math.max(0, Math.min(255, Math.round(c)))),
      error: p.error ?? -1,
      track,
    }
  })

  const cameras = images.map((im, i) => ({
    cameraId: i + 1,
    model: 'PINHOLE',
    width: im.width,
    height: im.height,
    params: [im.K.fx, im.K.fy, im.K.cx, im.K.cy],
  }))

  const colmapImages = images.map((im, i) => ({
    imageId: i + 1,
    q: rotationToQuat(im.R),
    t: [...im.t],
    cameraId: i + 1,
    name: im.name,
    points2D: points2D.get(im.uuid),
  }))

  return { cameras, images: colmapImages, points3D }
}

// Inverse: ColmapModel → websfm-shaped plain data (names, not uuids; the caller
// matches names to loaded images). Distortion coefficients are dropped;
// `dropped` collects the model names that carried any, for a caller warning.
//   → { images:[{ imageId, name, width, height, K, R, t }],
//       points:[{ xyz, color, error, views:[{ imageId, name, x, y }] }],
//       droppedDistortion: [modelName] }
export function readColmapModel(model) {
  const camById = new Map(model.cameras.map((c) => [c.cameraId, c]))
  const imgById = new Map(model.images.map((im) => [im.imageId, im]))
  const droppedDistortion = new Set()

  const images = model.images.map((im) => {
    const cam = camById.get(im.cameraId)
    const K = cam ? intrinsicsFromCamera(cam) : { fx: 0, fy: 0, cx: 0, cy: 0, dropped: [] }
    if (K.dropped && K.dropped.length) droppedDistortion.add(cam.model)
    return {
      imageId: im.imageId,
      name: im.name,
      width: cam?.width ?? 0,
      height: cam?.height ?? 0,
      K: { fx: K.fx, fy: K.fy, cx: K.cx, cy: K.cy },
      R: quatToRotation(im.q),
      t: [...im.t],
    }
  })

  const points = model.points3D.map((p) => ({
    xyz: p.xyz,
    color: p.rgb,
    error: p.error,
    views: p.track
      .map(([imageId, point2dIdx]) => {
        const im = imgById.get(imageId)
        const obs = im?.points2D[point2dIdx]
        if (!im || !obs) return null
        return { imageId, name: im.name, x: obs[0], y: obs[1] }
      })
      .filter(Boolean),
  }))

  return { images, points, droppedDistortion: [...droppedDistortion] }
}

// COLMAP-name → uuid resolver over the loaded images. The tiered matching rule is
// shared with the GCP / pose / footprint importers — see `core/io/nameMatch.js`.
//   loaded: [{ uuid, name }]
export function makeNameResolver(loaded) {
  return makeIdResolver(loaded, { key: 'uuid' })
}

// Turn `readColmapModel` output into websfm store shapes (a sparse cloud). Pure —
// `resolveUuid(name)` (e.g. from `makeNameResolver`) maps a COLMAP image name to a
// loaded-image uuid, or null when unmatched. Cameras/observations of unmatched
// images are dropped, as are points left with no matched view.
//
// Imported points carry no websfm keypoint indices (there are no store keypoints
// behind them), so `views` gets a synthetic per-image running index — dense only
// reads the view *uuids* (`mvs.js` `pt.views.map(([u])=>u)`), never the index — while
// the real pixel rides in `viewsPx`, the frame COLMAP re-export reads.
//   → { cameras: Map<uuid,{R,t,K}>,
//       points: [{ x, y, z, color, error, views: Map<uuid,idx>, viewsPx: Map<uuid,[x,y]> }],
//       matched: [{ name, uuid }], unmatched: [name] }
export function colmapToSparse({ images, points }, resolveUuid) {
  const uuidByImageId = new Map()
  const kpNext = new Map() // uuid → next synthetic keypoint index
  const cameras = new Map()
  const matched = []
  const unmatched = []

  for (const im of images) {
    const uuid = resolveUuid(im.name)
    if (!uuid) { unmatched.push(im.name); continue }
    uuidByImageId.set(im.imageId, uuid)
    kpNext.set(uuid, 0)
    cameras.set(uuid, { R: im.R, t: [...im.t], K: { ...im.K } })
    matched.push({ name: im.name, uuid })
  }

  const outPoints = []
  for (const p of points) {
    const views = new Map()
    const viewsPx = new Map()
    for (const v of p.views) {
      const uuid = uuidByImageId.get(v.imageId)
      if (!uuid || views.has(uuid)) continue // unmatched image, or a repeat obs
      const idx = kpNext.get(uuid); kpNext.set(uuid, idx + 1)
      views.set(uuid, idx)
      viewsPx.set(uuid, [v.x, v.y])
    }
    if (!views.size) continue // observed only in unmatched images
    outPoints.push({
      x: p.xyz[0], y: p.xyz[1], z: p.xyz[2],
      color: p.color, error: p.error, views, viewsPx,
    })
  }

  return { cameras, points: outPoints, matched, unmatched }
}
