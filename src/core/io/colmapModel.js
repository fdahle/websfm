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

// Build a tiered COLMAP-name → uuid resolver over the loaded images. COLMAP stores
// whatever path was given at reconstruction time (often a bare filename, sometimes a
// relative path); websfm images key by `name`. Match progressively looser: exact →
// basename → case-insensitive basename → basename without extension. First match
// wins per tier; an unmatched name returns null.
//   loaded: [{ uuid, name }]
export function makeNameResolver(loaded) {
  const basename = (n) => String(n).split(/[\\/]/).pop()
  const stem = (n) => basename(n).replace(/\.[^.]+$/, '')
  const exact = new Map(), base = new Map(), baseLower = new Map(), stemLower = new Map()
  for (const { uuid, name } of loaded) {
    if (name == null) continue
    if (!exact.has(name)) exact.set(name, uuid)
    const b = basename(name)
    if (!base.has(b)) base.set(b, uuid)
    const bl = b.toLowerCase()
    if (!baseLower.has(bl)) baseLower.set(bl, uuid)
    const sl = stem(name).toLowerCase()
    if (!stemLower.has(sl)) stemLower.set(sl, uuid)
  }
  return (name) => {
    if (name == null) return null
    return exact.get(name)
      ?? base.get(basename(name))
      ?? baseLower.get(basename(name).toLowerCase())
      ?? stemLower.get(stem(name).toLowerCase())
      ?? null
  }
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
