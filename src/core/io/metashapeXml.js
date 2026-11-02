// Agisoft Metashape interchange: the XML that Metashape writes with File ▸ Export ▸
// Export Cameras (sensors and aligned cameras) and Export Markers (the same document
// plus markers and their image marks). Version 1.x keeps markers in the cameras file;
// 2.x writes them only into the markers file. Both read the same here. Pure.
//
// readMetashapeXml(text) → { version, chunks: [chunk] }, the document as data.
// metashapeChunkToImport(chunk, opts) → the calibration, camera poses and GCPs in the
// shapes WebSfM's own importers take (core/io/sensor.js buildSensors, pose.js
// buildPoses, gcp.js buildGcps), plus warnings.
//
// Conventions, checked against Metashape 2.2 (camera.project, Export Cameras ▸ Omega
// Phi Kappa) on a 42-image block: 1e-8 px and 1e-9 in the rotation matrix.
// - A camera's <transform> maps camera coordinates (x right, y down, z forward) into
//   its component's frame (2.x) or the chunk's (1.x); the component or chunk
//   <transform> (rotation R, translation t, scale s) maps that frame to geocentric
//   coordinates of the chunk CRS's datum: X = s·R·x + t.
// - The frame model is u = W/2 + cx + x'(f + b1) + y'·b2, v = H/2 + cy + y'·f in
//   pixel-edge coordinates (the top-left corner is 0,0), with
//   x' = x(1 + k1r² + k2r⁴ + k3r⁶ + k4r⁸) + p1(r² + 2x²) + 2p2·xy and the y-term
//   with p1 and p2 exchanged. So Metashape's p1 is OpenCV's (and WebSfM's) p2 and the
//   other way round; its k4 is an r⁸ term, not WebSfM's rational k4; WebSfM's sensor
//   cx/cy count from pixel centres, ½ px less than W/2 + cx. Marks use pixel edges, as
//   WebSfM's do.
// - Omega/phi/kappa are WebSfM's (footprint.js opkMatrix), taken against the target
//   CRS's grid north at each camera, as Metashape's own export does.

import { parseXml, child, childrenOf, childNumber, numberList } from './xmlLite.js'
import { opkFromMatrix } from '../footprint.js'

// ── Reading ───────────────────────────────────────────────────────────────────

const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)
const bool = (v, dflt = true) => (v == null ? dflt : v !== 'false' && v !== '0')

function readTransform(el) {
  if (!el) return null
  const R = numberList(child(el, 'rotation')?.text)
  const t = numberList(child(el, 'translation')?.text)
  const s = childNumber(el, 'scale') ?? 1
  if (R.length !== 9 || t.length !== 3) return null
  return { R: [R.slice(0, 3), R.slice(3, 6), R.slice(6, 9)], t, s }
}

function readCalibration(el) {
  const res = child(el, 'resolution')
  const c = { type: el.attrs.type ?? 'frame', class: el.attrs.class ?? 'initial' }
  c.width = num(res?.attrs.width)
  c.height = num(res?.attrs.height)
  for (const k of ['f', 'cx', 'cy', 'b1', 'b2', 'k1', 'k2', 'k3', 'k4', 'p1', 'p2', 'p3', 'p4'])
    c[k] = childNumber(el, k) ?? 0
  return c
}

function readSensor(el) {
  const prop = (name) => num(childrenOf(el, 'property').find((p) => p.attrs.name === name)?.attrs.value)
  const res = child(el, 'resolution')
  const cals = childrenOf(el, 'calibration').map(readCalibration)
  return {
    id: el.attrs.id,
    label: el.attrs.label ?? null,
    type: el.attrs.type ?? 'frame',
    width: num(res?.attrs.width),
    height: num(res?.attrs.height),
    pixelSize: prop('pixel_width'),
    focalMm: prop('focal_length'),
    // The adjusted calibration when the chunk was optimised, else the initial one.
    calibration: cals.find((c) => c.class === 'adjusted') ?? cals.find((c) => c.class !== 'adjusted') ?? null,
  }
}

function readReference(el) {
  if (!el) return null
  const a = el.attrs
  return {
    x: num(a.x),
    y: num(a.y),
    z: num(a.z),
    sx: num(a.sx ?? a.sxy ?? a.sxyz),
    sy: num(a.sy ?? a.sxy ?? a.sxyz),
    sz: num(a.sz ?? a.sxyz),
    enabled: bool(a.enabled),
  }
}

// The CRS a chunk's <reference> names: its EPSG code (the horizontal part of a
// compound CRS), whether it is a local frame, and the vertical datum it implies.
export function readChunkCrs(wkt) {
  const text = String(wkt ?? '').trim()
  if (!text || /^LOCAL_CS/i.test(text)) return { wkt: text, epsg: null, local: true, verticalDatum: 'local' }
  const horizontal = firstBlock(text, /(PROJCS|GEOGCS)\[/) ?? text
  const auth = topLevelAuthority(horizontal)
  const vert = firstBlock(text, /VERT_CS\[/)
  let verticalDatum = 'ellipsoidal'
  if (vert) {
    if (/EGM2008/i.test(vert)) verticalDatum = 'geoid:EGM2008'
    else if (/EGM96/i.test(vert)) verticalDatum = 'geoid:EGM96'
    else verticalDatum = 'orthometric'
  }
  return { wkt: text, epsg: auth ? `EPSG:${auth}` : null, local: false, verticalDatum }
}

function firstBlock(text, re) {
  const m = re.exec(text)
  if (!m) return null
  let depth = 0
  for (let i = m.index + m[0].length - 1; i < text.length; i++) {
    if (text[i] === '[') depth++
    else if (text[i] === ']' && --depth === 0) return text.slice(m.index, i + 1)
  }
  return null
}

function topLevelAuthority(block) {
  let depth = 0,
    found = null
  const re = /AUTHORITY\["EPSG","(\d+)"\]|\[|\]/g
  for (const m of block.matchAll(re)) {
    if (m[0] === '[') depth++
    else if (m[0] === ']') depth--
    else if (depth === 1) found = m[1]
  }
  return found
}

export function readMetashapeXml(text) {
  const root = parseXml(text)
  if (root.name !== 'document') throw new Error('Not a Metashape XML file (no <document>)')
  const chunkEls = root.children.filter((c) => c.name === 'chunk')
  if (!chunkEls.length) throw new Error('The Metashape file holds no chunk')
  return { version: root.attrs.version ?? null, chunks: chunkEls.map(readChunk) }
}

function readChunk(el) {
  const sensors = childrenOf(child(el, 'sensors'), 'sensor').map(readSensor)
  const components = new Map(
    childrenOf(child(el, 'components'), 'component').map((c) => [c.attrs.id, readTransform(child(c, 'transform'))]),
  )
  const cameraEls = (group) =>
    group.children.flatMap((c) => (c.name === 'camera' ? [c] : c.name === 'group' ? cameraEls(c) : []))
  const camerasEl = child(el, 'cameras')
  const cameras = (camerasEl ? cameraEls(camerasEl) : []).map((c) => {
    const m = numberList(child(c, 'transform')?.text)
    return {
      id: c.attrs.id,
      label: c.attrs.label ?? '',
      sensorId: c.attrs.sensor_id ?? null,
      componentId: c.attrs.component_id ?? null,
      enabled: bool(c.attrs.enabled),
      transform: m.length === 16 ? m : null,
      locationCovariance: numberList(child(c, 'location_covariance')?.text),
      reference: readReference(child(c, 'reference')),
    }
  })
  const locations = new Map()
  for (const frame of childrenOf(child(el, 'frames'), 'frame')) {
    for (const mk of childrenOf(child(frame, 'markers'), 'marker')) {
      const list = locations.get(mk.attrs.marker_id) ?? []
      for (const loc of childrenOf(mk, 'location')) {
        list.push({
          cameraId: loc.attrs.camera_id,
          x: num(loc.attrs.x),
          y: num(loc.attrs.y),
          pinned: bool(loc.attrs.pinned),
        })
      }
      locations.set(mk.attrs.marker_id, list)
    }
  }
  const markers = childrenOf(child(el, 'markers'), 'marker').map((m) => ({
    id: m.attrs.id,
    label: m.attrs.label ?? `point ${m.attrs.id}`,
    reference: readReference(child(m, 'reference')),
    locations: locations.get(m.attrs.id) ?? [],
  }))
  const crs = readChunkCrs(child(el, 'reference')?.text)
  return {
    label: el.attrs.label ?? 'Chunk',
    enabled: bool(el.attrs.enabled),
    crs,
    transform: readTransform(child(el, 'transform')),
    components,
    sensors,
    cameras,
    markers,
    scalebars: childrenOf(child(el, 'scalebars'), 'scalebar').length,
  }
}

// ── Geodesy ───────────────────────────────────────────────────────────────────

// The ellipsoid of a proj4 definition: { a, f }. Null when the definition names none
// this table knows (then a georeferenced chunk cannot be placed).
const ELLIPSOIDS = {
  WGS84: [6378137, 1 / 298.257223563],
  GRS80: [6378137, 1 / 298.257222101],
  bessel: [6377397.155, 1 / 299.1528128],
  intl: [6378388, 1 / 297],
  clrk66: [6378206.4, 1 / 294.978698214],
  clrk80: [6378249.145, 1 / 293.465],
  airy: [6377563.396, 1 / 299.3249646],
  krass: [6378245, 1 / 298.3],
}
const DATUM_ELLIPSOID = { WGS84: 'WGS84', NAD83: 'GRS80', NAD27: 'clrk66', potsdam: 'bessel', OSGB36: 'airy' }

export function ellipsoidOf(projDef) {
  const tok = (k) => String(projDef ?? '').match(new RegExp(`\\+${k}=(\\S+)`))?.[1]
  const a = num(tok('a')),
    rf = num(tok('rf')),
    b = num(tok('b'))
  if (a && rf) return { a, f: 1 / rf }
  if (a && b) return { a, f: (a - b) / a }
  const name = tok('ellps') ?? DATUM_ELLIPSOID[tok('datum')]
  const e = ELLIPSOIDS[name]
  return e ? { a: e[0], f: e[1] } : null
}

// A geographic (+proj=longlat) definition on the same datum as `projDef`: where the
// chunk's geocentric coordinates, turned into longitude and latitude, live.
export function geographicDefOf(projDef) {
  const keep = String(projDef ?? '')
    .split(/\s+/)
    .filter((t) => /^\+(datum|ellps|a|b|rf|towgs84|nadgrids|pm)=/.test(t))
  return `+proj=longlat ${keep.join(' ')} +no_defs`.replace(/\s+/g, ' ')
}

// Geocentric X/Y/Z → [lon°, lat°, h] on the ellipsoid { a, f } (Bowring's formula
// and two refinements: well under a millimetre for heights below 10,000 km).
export function geocentricToGeodetic([X, Y, Z], { a, f }) {
  const e2 = f * (2 - f),
    b = a * (1 - f),
    ep2 = (a * a - b * b) / (b * b)
  const p = Math.hypot(X, Y),
    lon = Math.atan2(Y, X)
  let lat = Math.atan2(Z * a, p * b)
  lat = Math.atan2(Z + ep2 * b * Math.sin(lat) ** 3, p - e2 * a * Math.cos(lat) ** 3)
  let N = 0,
    h = 0
  for (let i = 0; i < 3; i++) {
    const s = Math.sin(lat)
    N = a / Math.sqrt(1 - e2 * s * s)
    h = p / Math.cos(lat) - N
    lat = Math.atan2(Z, p * (1 - (e2 * N) / (N + h)))
  }
  const s = Math.sin(lat)
  N = a / Math.sqrt(1 - e2 * s * s)
  h = Math.abs(Math.cos(lat)) > 1e-12 ? p / Math.cos(lat) - N : Math.abs(Z) - b
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI, h]
}

// Rows of this matrix are east, north and up at (lon°, lat°), in geocentric axes.
function enuBasis(lonDeg, latDeg) {
  const lo = (lonDeg * Math.PI) / 180,
    la = (latDeg * Math.PI) / 180
  const so = Math.sin(lo),
    co = Math.cos(lo),
    sa = Math.sin(la),
    ca = Math.cos(la)
  return [
    [-so, co, 0],
    [-sa * co, -sa * so, ca],
    [ca * co, ca * so, sa],
  ]
}

// ── Conversion ────────────────────────────────────────────────────────────────

const mul = (A, B) => A.map((r) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const mulv = (A, v) => A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
const T = (A) => A[0].map((_, j) => A.map((r) => r[j]))

const metashapeCoeffs = (c) => ['k1', 'k2', 'k3', 'p1', 'p2'].some((k) => c[k])

// The largest pixel shift a set of terms makes anywhere in the frame (its corners).
function cornerShiftPx(c, terms) {
  const xs = (c.width / 2 + Math.abs(c.cx)) / c.f,
    ys = (c.height / 2 + Math.abs(c.cy)) / c.f
  const r2 = xs * xs + ys * ys
  let px = 0
  if (terms.includes('k4')) px = Math.max(px, Math.abs(c.k4) * r2 ** 4 * Math.sqrt(r2) * c.f)
  if (terms.includes('b1')) px = Math.max(px, Math.abs(c.b1) * xs)
  if (terms.includes('b2')) px = Math.max(px, Math.abs(c.b2) * ys)
  if (terms.includes('p3')) px = Math.max(px, (Math.abs(c.p3) * r2 + Math.abs(c.p4) * r2 * r2) * Math.sqrt(r2) * c.f)
  return px
}

// The calibration of one Metashape sensor as a WebSfM sensor (buildSensors' shape),
// or { skip: reason }. `images` are the labels of the sensor's cameras.
export function metashapeSensor(sensor, images = []) {
  const c = sensor.calibration
  if (!c || !(c.f > 0)) return { skip: `${sensor.label ?? 'a sensor'} has no calibration` }
  if (sensor.type !== 'frame' && sensor.type !== 'fisheye')
    return { skip: `${sensor.label ?? 'a sensor'} is a ${sensor.type} camera, which WebSfM does not model` }
  const width = c.width ?? sensor.width,
    height = c.height ?? sensor.height
  const fisheye = sensor.type === 'fisheye'
  const out = {
    label: sensor.label,
    images,
    focalUnit: 'px',
    width,
    height,
    focal: c.f,
    cx: width / 2 + c.cx - 0.5,
    cy: height / 2 + c.cy - 0.5,
    ppxMm: null,
    ppyMm: null,
    k1: c.k1 || null,
    k2: c.k2 || null,
    k3: c.k3 || null,
    k4: fisheye ? c.k4 || null : null,
    k5: null,
    k6: null,
    // Metashape's p1/p2 are OpenCV's p2/p1.
    p1: fisheye ? null : c.p2 || null,
    p2: fisheye ? null : c.p1 || null,
    pixelSize: sensor.pixelSize ?? null,
    distortionModel: fisheye ? 'fisheye' : metashapeCoeffs(c) ? 'brown' : 'pinhole',
    marks: null,
  }
  const dropped = fisheye
    ? ['b1', 'b2', 'p1', 'p2', 'p3'].filter((k) => c[k])
    : ['k4', 'b1', 'b2', 'p3'].filter((k) => c[k])
  const shift = fisheye ? null : cornerShiftPx({ ...c, width, height }, dropped)
  return { sensor: out, dropped, droppedPx: shift }
}

// The geocentric camera centre and camera axes (columns: x right, y down, z forward).
function cameraInGeocentric(cam, frameOf) {
  const F = frameOf(cam)
  if (!F || !cam.transform) return null
  const m = cam.transform
  const Rl = [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ]
  const c = [m[3], m[7], m[11]]
  const C = mulv(F.R, c).map((v, i) => F.s * v + F.t[i])
  return { C, axes: mul(F.R, Rl) }
}

// One chunk → { sensors, poses, gcps, warnings, counts }.
//   ellipsoid   { a, f } of the chunk CRS's datum (ellipsoidOf), for a georeferenced chunk
//   toTarget    (lon, lat) on that datum → [x, y] in the target CRS (positions and the
//               grid north the angles are taken against)
//   fromChunk   [x, y] in the chunk CRS → [x, y] in the target CRS (marker coordinates)
//   metric      the target CRS is in metres (position accuracies are given only then)
// A local chunk (no CRS) gives the calibration and markers with their marks only.
export function metashapeChunkToImport(
  chunk,
  { ellipsoid = null, toTarget = null, fromChunk = null, metric = true } = {},
) {
  const warnings = []
  const byId = new Map(chunk.cameras.map((c) => [c.id, c]))

  // Calibration
  const sensors = []
  for (const s of chunk.sensors) {
    const images = chunk.cameras.filter((c) => c.sensorId === s.id).map((c) => c.label)
    const r = metashapeSensor(s, images)
    if (r.skip) {
      warnings.push(`Calibration: ${r.skip}; its photos keep their own.`)
      continue
    }
    if (r.dropped.length)
      warnings.push(
        `Calibration of ${s.label ?? 'a sensor'}: ${r.dropped.join(', ')} left out (WebSfM has no such terms)` +
          (r.droppedPx != null ? `, up to ${r.droppedPx.toFixed(2)} px at the corners.` : '.'),
      )
    sensors.push(r.sensor)
  }

  // Camera poses
  const poses = []
  const georef = !chunk.crs.local && ellipsoid && toTarget
  const frameOf = (cam) => (cam.componentId != null && chunk.components.get(cam.componentId)) || chunk.transform
  const aligned = chunk.cameras.filter((c) => c.transform)
  if (!chunk.crs.local && !georef && aligned.length)
    warnings.push(
      `Camera poses left out: the chunk's coordinate system (${chunk.crs.epsg ?? 'unnamed'}) could not be used.`,
    )
  else if (chunk.crs.local && aligned.length)
    warnings.push('Camera poses left out: the chunk is in a local frame, with no coordinate system to place them in.')
  if (georef) {
    for (const cam of aligned) {
      const g = cameraInGeocentric(cam, frameOf)
      if (!g) continue
      const [lon, lat, h] = geocentricToGeodetic(g.C, ellipsoid)
      const [x, y] = toTarget(lon, lat)
      // Grid north at the camera: the direction a small step north takes in the target CRS.
      const [x2, y2] = toTarget(lon, lat + 1e-5)
      const gamma = -Math.atan2(x2 - x, y2 - y)
      const cg = Math.cos(gamma),
        sg = Math.sin(gamma)
      const G = [
        [cg, -sg, 0],
        [sg, cg, 0],
        [0, 0, 1],
      ]
      const toGrid = mul(G, enuBasis(lon, lat))
      // Photo → object rotation (photo axes x right, y up, looking along −z).
      const axes = mul(toGrid, g.axes)
      const opk = opkFromMatrix(axes.map((r) => [r[0], -r[1], -r[2]]))
      const pose = {
        imageName: cam.label,
        x,
        y,
        z: h,
        omega: opk?.omega ?? null,
        phi: opk?.phi ?? null,
        kappa: opk?.kappa ?? null,
        accuracyX: null,
        accuracyY: null,
        accuracyZ: null,
        accXYZ: null,
        accuracyOmega: null,
        accuracyPhi: null,
        accuracyKappa: null,
        accAngle: null,
        verticalDatum: chunk.crs.verticalDatum === 'ellipsoidal' ? 'ellipsoidal' : 'unknown',
        enabled: cam.enabled,
      }
      if (metric && cam.locationCovariance.length === 9) {
        const F = frameOf(cam)
        const Cl = [
          cam.locationCovariance.slice(0, 3),
          cam.locationCovariance.slice(3, 6),
          cam.locationCovariance.slice(6),
        ]
        const W = mul(toGrid, F.R)
        const Cw = mul(mul(W, Cl), T(W)).map((r) => r.map((v) => v * F.s * F.s))
        ;[pose.accuracyX, pose.accuracyY, pose.accuracyZ] = [0, 1, 2].map((i) => Math.sqrt(Math.max(0, Cw[i][i])))
      }
      poses.push(pose)
    }
  }

  // Markers → GCPs with their marks. Unpinned marks are Metashape's own projections,
  // not placed by anyone, so only pinned ones come along.
  const gcps = []
  for (const m of chunk.markers) {
    const ref = m.reference
    const hasXYZ = !chunk.crs.local && ref && ref.x != null && ref.y != null
    const [x, y] = hasXYZ ? (fromChunk ? fromChunk(ref.x, ref.y) : [ref.x, ref.y]) : [null, null]
    const observations = m.locations
      .filter((l) => l.pinned && l.x != null && byId.has(l.cameraId))
      .map((l) => ({ imageName: byId.get(l.cameraId).label, px: l.x, py: l.y, accuracyX: null, accuracyY: null }))
    gcps.push({
      name: m.label,
      role: !hasXYZ ? 'marker' : ref.enabled ? 'control' : 'check',
      x,
      y,
      z: hasXYZ ? ref.z : null,
      accuracyX: hasXYZ ? ref.sx : null,
      accuracyY: hasXYZ ? ref.sy : null,
      accuracyZ: hasXYZ ? ref.sz : null,
      observations,
      correlationXY: null,
      correlationXZ: null,
      correlationYZ: null,
    })
  }
  if (chunk.scalebars) warnings.push(`${chunk.scalebars} scale bar(s) left out: add them in Scale bars.`)

  return {
    sensors,
    poses,
    gcps,
    warnings,
    counts: {
      cameras: chunk.cameras.length,
      aligned: aligned.length,
      sensors: sensors.length,
      markers: gcps.length,
      marks: gcps.reduce((n, g) => n + g.observations.length, 0),
    },
  }
}

// A calibration made at another photo size (Metashape run on full-size photos, the
// project on smaller copies, or the other way round), scaled to `width` × `height`.
// The distortion terms are in normalised coordinates and stay; the pixel quantities
// scale, the principal point about the pixel-centre convention. Null when the aspect
// differs (a crop, not a resize: nothing can be scaled).
export function scaleSensorTo(sensor, width, height) {
  if (!(width > 0 && height > 0) || !(sensor.width > 0 && sensor.height > 0)) return sensor
  if (width === sensor.width && height === sensor.height) return sensor
  const sx = width / sensor.width,
    sy = height / sensor.height
  if (Math.abs(sx / sy - 1) > 0.005) return null
  return {
    ...sensor,
    width,
    height,
    focal: sensor.focal * sx,
    cx: (sensor.cx + 0.5) * sx - 0.5,
    cy: (sensor.cy + 0.5) * sy - 0.5,
    pixelSize: sensor.pixelSize != null ? sensor.pixelSize / sx : null,
  }
}
