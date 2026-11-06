// A whole Agisoft Metashape project (Import ▸ Metashape ▸ Project): a .psz file (one
// zip: doc.xml and every asset beside it) or a .psx with its .files folder (a zip per
// part: project.zip → <n>/chunk.zip → <n>/<f>/frame.zip → point_cloud/point_cloud.zip,
// model/model.zip …). Pure: the composable (composables/metashapeProjectFiles.js) reads
// the files; this turns their contents into what WebSfM imports.
//
// From the chunk's XML, the same as an exported cameras/markers file (metashapeXml.js):
// calibration, camera poses, markers and scale bars. From its tie points:
//   tracks.ply           a colour per track
//   points<c>.ply        the triangulated tracks of component c: x y z (the component's
//                        internal frame) and the track id
//   p<k>.ply / projections<k>.ply
//                        camera k's keypoints on tracks: x y (pixel edges) size, track id
// → keypoints per photo, matches between photos that share a track, and the sparse
// model (the aligned cameras and the points). Not read: the dense cloud (.oc3, a format
// of Metashape's own), the depth maps, and the DEM and orthomosaic, which Metashape keeps
// in tiles; export those from Metashape (LAS/LAZ, GeoTIFF) and import them as files.

import { parseXml, child, childrenOf } from './xmlLite.js'
import { readMetashapeChunk, metashapeSensor } from './metashapeXml.js'
import { distortionOf } from '../sfm/distortion.js'

// ── Assembling a .psx ──────────────────────────────────────────────────────────

/**
 * A .psx chunk: its chunk.zip doc.xml, with each `<frame path=…>` replaced by the
 * frame.zip doc.xml it names. frameXml(path) → the text of that frame's doc.xml (path
 * relative to the chunk's folder), or null.
 */
export function readPsxChunk(chunkXml, frameXml) {
  const el = parseXml(chunkXml)
  if (el.name !== 'chunk') throw new Error('Not a Metashape chunk document')
  const frames = child(el, 'frames')
  if (frames) {
    frames.children = frames.children.map((f) => {
      const text = f.attrs.path ? frameXml(f.attrs.path) : null
      if (!text) return f
      const frame = parseXml(text)
      frame.attrs = { ...frame.attrs, id: f.attrs.id, base: f.attrs.path.replace(/[^/]+$/, '') }
      return frame
    })
  }
  return readMetashapeChunk(el)
}

/** The chunk paths a .psx project.zip doc.xml lists, active one first. */
export function psxChunkPaths(projectXml) {
  const root = parseXml(projectXml)
  const chunks = child(root, 'chunks')
  const list = childrenOf(chunks, 'chunk')
  const active = chunks?.attrs.active_id
  return [...list.filter((c) => c.attrs.id === active), ...list.filter((c) => c.attrs.id !== active)]
    .map((c) => c.attrs.path)
    .filter(Boolean)
}

/** The tie-point file list of a .psx point_cloud.zip doc.xml. */
export function readPointCloudDoc(xml) {
  const pc = parseXml(xml)
  return {
    tracks: child(pc, 'tracks')?.attrs.path ?? null,
    points: childrenOf(pc, 'points').map((p) => ({ componentId: p.attrs.component_id ?? null, path: p.attrs.path })),
    projections: childrenOf(pc, 'projections').map((p) => ({ cameraId: p.attrs.camera_id, path: p.attrs.path })),
  }
}

/** The mesh file a .psx model.zip doc.xml names. */
export const readModelDoc = (xml) => child(parseXml(xml), 'mesh')?.attrs.path ?? null

// ── PLY vertex tables ──────────────────────────────────────────────────────────

const TYPES = {
  char: ['getInt8', 1],
  int8: ['getInt8', 1],
  uchar: ['getUint8', 1],
  uint8: ['getUint8', 1],
  short: ['getInt16', 2],
  int16: ['getInt16', 2],
  ushort: ['getUint16', 2],
  uint16: ['getUint16', 2],
  int: ['getInt32', 4],
  int32: ['getInt32', 4],
  uint: ['getUint32', 4],
  uint32: ['getUint32', 4],
  float: ['getFloat32', 4],
  float32: ['getFloat32', 4],
  double: ['getFloat64', 8],
  float64: ['getFloat64', 8],
}

/**
 * The vertex element of a binary little-endian PLY, any properties: Metashape's tie
 * point files carry no z (projections) or no position at all (tracks), which a cloud
 * reader refuses. → { count, columns: { name: Float64Array } }
 */
export function readPlyVertices(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const headEnd = findHeaderEnd(u8)
  const header = new TextDecoder().decode(u8.subarray(0, headEnd)).split(/\r?\n/)
  if (header[0] !== 'ply') throw new Error('Not a PLY file')
  if (!header.some((l) => l === 'format binary_little_endian 1.0'))
    throw new Error('Only binary little-endian PLY files are read here')
  let count = 0,
    inVertex = false
  const props = []
  for (const line of header) {
    const t = line.trim().split(/\s+/)
    if (t[0] === 'element') {
      inVertex = t[1] === 'vertex'
      if (inVertex) count = Number(t[2])
    } else if (t[0] === 'property' && inVertex) {
      if (t[1] === 'list') throw new Error('PLY: list properties on vertices are not read')
      if (!TYPES[t[1]]) throw new Error(`PLY: unknown type ${t[1]}`)
      props.push({ name: t[2], type: TYPES[t[1]] })
    }
  }
  const stride = props.reduce((n, p) => n + p.type[1], 0)
  if (headEnd + count * stride > u8.length) throw new Error('PLY: vertex data truncated')
  const dv = new DataView(u8.buffer, u8.byteOffset + headEnd, count * stride)
  const columns = Object.fromEntries(props.map((p) => [p.name, new Float64Array(count)]))
  for (let i = 0, o = 0; i < count; i++)
    for (const p of props) {
      columns[p.name][i] = dv[p.type[0]](o, true)
      o += p.type[1]
    }
  return { count, columns }
}

function findHeaderEnd(u8) {
  const marker = 'end_header'
  for (let i = 0; i < Math.min(u8.length, 1 << 16); i++) {
    let hit = true
    for (let k = 0; k < marker.length && hit; k++) hit = u8[i + k] === marker.charCodeAt(k)
    if (!hit) continue
    let j = i + marker.length
    if (u8[j] === 13) j++
    if (u8[j] === 10) return j + 1
  }
  throw new Error('PLY: no end_header')
}

// ── Tie points ─────────────────────────────────────────────────────────────────

const mulv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
const T = (A) => A[0].map((_, j) => A.map((r) => r[j]))

/**
 * Keypoints, matches and the sparse model from a chunk's tie points.
 *   chunk        readMetashapeXml / readPsxChunk's chunk
 *   tracks       readPlyVertices(tracks.ply) or null
 *   points       [{ componentId, ply }] from points<c>.ply
 *   projections  [{ cameraId, ply }] from p<k>.ply
 * → {
 *     keypoints: [{ label, x: Float32Array, y, scale }],   per camera, pixel centres
 *     pairs: [{ a, b, idx: Uint32Array }],                  photos (labels) sharing tracks
 *     model: { format, images, points, warnings },          for importInteropModel
 *     counts: { photos, keypoints, tracks, pairs, matches, points, aligned }
 *   }
 * Keypoints are Metashape's pixel-edge positions less ½ px, as WebSfM's sensor and
 * camera centres count from pixel centres (metashapeXml.js). The model is in the
 * component's internal frame times its scale: metric, in Metashape's axes; georeference
 * it in WebSfM from the camera positions or GCPs as any imported model.
 */
export function metashapeTiePoints(chunk, { tracks = null, points = [], projections = [] }) {
  const cameras = new Map(chunk.cameras.map((c) => [c.id, c]))
  const sensors = new Map(chunk.sensors.map((s) => [s.id, s]))
  const keypoints = []
  // track id → [[camera index in `keypoints`, keypoint index]]
  const obs = new Map()
  for (const { cameraId, ply } of projections) {
    const cam = cameras.get(cameraId)
    if (!cam || !ply?.count) continue
    const { x, y, size, id } = ply.columns
    if (!x || !y || !id) continue
    const k = keypoints.length
    keypoints.push({
      label: cam.label,
      cameraId,
      x: Float32Array.from(x, (v) => v - 0.5),
      y: Float32Array.from(y, (v) => v - 0.5),
      scale: size ? Float32Array.from(size) : null,
    })
    for (let i = 0; i < id.length; i++) {
      const t = id[i]
      if (t < 0) continue
      let list = obs.get(t)
      if (!list) obs.set(t, (list = []))
      list.push([k, i])
    }
  }
  // Every pair of photos on a track is a match.
  const pairMap = new Map()
  for (const list of obs.values()) {
    if (list.length < 2) continue
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const [ka, ia] = list[i],
          [kb, ib] = list[j]
        if (ka === kb) continue
        const [lo, hi, ilo, ihi] = ka < kb ? [ka, kb, ia, ib] : [kb, ka, ib, ia]
        const key = lo * 65536 + hi
        let p = pairMap.get(key)
        if (!p) pairMap.set(key, (p = { a: keypoints[lo].label, b: keypoints[hi].label, values: [] }))
        p.values.push(ilo, ihi)
      }
  }
  const pairs = [...pairMap.values()].map((p) => ({ a: p.a, b: p.b, idx: Uint32Array.from(p.values) }))

  // The sparse model: aligned cameras in their component's frame, scaled to metres.
  const scaleOf = (componentId) => chunk.components.get(componentId)?.s ?? chunk.transform?.s ?? 1
  const images = []
  const imageIdOf = new Map() // camera id → model image id
  for (const cam of chunk.cameras) {
    if (!cam.transform) continue
    const sensor = sensors.get(cam.sensorId)
    const calib = sensor ? metashapeSensor(sensor) : null
    if (!calib?.sensor) continue
    const s = scaleOf(cam.componentId)
    const m = cam.transform
    const Rc = [
      [m[0], m[1], m[2]],
      [m[4], m[5], m[6]],
      [m[8], m[9], m[10]],
    ]
    const C = [m[3] * s, m[7] * s, m[11] * s]
    const R = T(Rc) // world → camera
    const t = mulv(R, C).map((v) => -v)
    const c = calib.sensor
    images.push({
      externalId: cam.id,
      imageId: images.length,
      name: cam.label,
      width: c.width,
      height: c.height,
      K: { fx: c.focal, fy: c.focal, cx: c.cx, cy: c.cy },
      // The adjusted lens: the tie points are in the pixels it recorded.
      lens: distortionOf(c),
      R,
      t,
      componentId: cam.componentId,
    })
    imageIdOf.set(cam.id, images.length - 1)
  }
  const colour = tracks?.columns
  const modelPoints = []
  for (const { componentId, ply } of points) {
    if (!ply?.count) continue
    const { x, y, z, id } = ply.columns
    const s = scaleOf(componentId)
    for (let i = 0; i < ply.count; i++) {
      const track = id[i]
      const views = []
      for (const [k, kp] of obs.get(track) ?? []) {
        const imageId = imageIdOf.get(keypoints[k].cameraId)
        if (imageId == null) continue
        views.push({ imageId, name: keypoints[k].label, x: keypoints[k].x[kp], y: keypoints[k].y[kp] })
      }
      if (views.length < 2) continue
      modelPoints.push({
        xyz: [x[i] * s, y[i] * s, z[i] * s],
        color: colour?.red ? [colour.red[track], colour.green[track], colour.blue[track]] : null,
        error: -1,
        views,
      })
    }
  }
  const warnings = []
  const components = new Set(images.map((im) => im.componentId))
  if (components.size > 1)
    warnings.push(`The chunk has ${components.size} components; each keeps its own frame, so they do not line up`)
  return {
    keypoints,
    pairs,
    model: { format: 'Metashape', images, points: modelPoints, warnings },
    counts: {
      photos: keypoints.length,
      keypoints: keypoints.reduce((n, k) => n + k.x.length, 0),
      tracks: obs.size,
      pairs: pairs.length,
      matches: pairs.reduce((n, p) => n + p.idx.length / 2, 0),
      points: modelPoints.length,
      aligned: images.length,
    },
  }
}

/**
 * A chunk's mesh (model.ply, parsePly's mesh) in the frame of the sparse model of
 * metashapeTiePoints: the mesh is in the chunk's internal frame, the model in its
 * component's, times the component's scale. Through geocentric coordinates when the two
 * frames differ (X = s·R·x + t each); the positions are new, the faces and colours kept.
 */
export function metashapeMeshToModel(chunk, mesh, componentId = null) {
  const K = chunk.transform
  const C = (componentId != null && chunk.components.get(componentId)) || K
  const pos = new Float64Array(mesh.pos.length)
  const same = !K || !C || K === C
  const s = (same ? (C ?? K)?.s : null) ?? 1
  for (let i = 0; i < pos.length; i += 3) {
    const v = [mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]]
    if (same) {
      pos[i] = v[0] * s
      pos[i + 1] = v[1] * s
      pos[i + 2] = v[2] * s
      continue
    }
    const g = mulv(K.R, v).map((x, k) => K.s * x + K.t[k] - C.t[k])
    const m = mulv(T(C.R), g)
    pos[i] = m[0]
    pos[i + 1] = m[1]
    pos[i + 2] = m[2]
  }
  return { ...mesh, pos }
}
