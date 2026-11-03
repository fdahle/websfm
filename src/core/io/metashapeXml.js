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
    scalebars: childrenOf(child(el, 'scalebars'), 'scalebar').map(readScalebar),
  }
}

// A scale bar: two endpoints, each a marker or a camera, and its reference distance
// (chunk units, metres), accuracy, and whether it takes part (enabled) or checks.
function readScalebar(el) {
  const ends = childrenOf(el, 'endpoint').map((e) =>
    e.attrs.marker_id != null
      ? { kind: 'marker', id: e.attrs.marker_id }
      : e.attrs.camera_id != null
        ? { kind: 'camera', id: e.attrs.camera_id }
        : null,
  )
  const ref = child(el, 'reference')
  return {
    id: el.attrs.id,
    label: el.attrs.label ?? `scalebar ${el.attrs.id}`,
    a: ends[0] ?? null,
    b: ends[1] ?? null,
    distance: num(ref?.attrs.d),
    accuracy: num(ref?.attrs.accuracy),
    enabled: ref ? bool(ref.attrs.enabled) : false,
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

// One chunk → { sensors, poses, gcps, scaleBars, warnings, counts }. A scale bar is
// { name, a, b: { kind: 'marker' | 'camera', name }, distanceM, accuracyM, enabled }.
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
  // Scale bars between markers or cameras, by name: the importer finds them among the
  // GCPs it added and the project's photos.
  const markerLabel = new Map(chunk.markers.map((m) => [m.id, m.label]))
  const endName = (e) => (e?.kind === 'marker' ? markerLabel.get(e.id) : e ? byId.get(e.id)?.label : null)
  const scaleBars = []
  let unusable = 0
  for (const sb of chunk.scalebars) {
    const a = endName(sb.a),
      b = endName(sb.b)
    if (!a || !b || !(sb.distance > 0)) {
      unusable++
      continue
    }
    scaleBars.push({
      name: sb.label,
      a: { kind: sb.a.kind, name: a },
      b: { kind: sb.b.kind, name: b },
      distanceM: sb.distance,
      accuracyM: sb.accuracy > 0 ? sb.accuracy : null,
      enabled: sb.enabled,
    })
  }
  if (unusable) warnings.push(`${unusable} scale bar(s) without two endpoints or a distance left out.`)

  return {
    sensors,
    poses,
    gcps,
    scaleBars,
    warnings,
    counts: {
      cameras: chunk.cameras.length,
      aligned: aligned.length,
      sensors: sensors.length,
      markers: gcps.length,
      marks: gcps.reduce((n, g) => n + g.observations.length, 0),
      scaleBars: scaleBars.length,
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

// ── Writing ───────────────────────────────────────────────────────────────────

// Metashape's frame model u = W/2 + cx + x'·f, v = H/2 + cy + y'·f (pixel edges),
// with its k1–k3 and p1/p2 (core of the reader above), at normalised point (x, y).
function metashapeProject(c, x, y, W, H) {
  const r2 = x * x + y * y
  const rad = 1 + r2 * (c.k1 + r2 * (c.k2 + r2 * c.k3))
  const xd = x * rad + c.p1 * (r2 + 2 * x * x) + 2 * c.p2 * x * y
  const yd = y * rad + c.p2 * (r2 + 2 * y * y) + 2 * c.p1 * x * y
  return [W / 2 + c.cx + xd * c.f, H / 2 + c.cy + yd * c.f]
}

const FRAME_TERMS = ['f', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2']

// One Metashape frame calibration for a WebSfM camera: K (pinhole, pixel centres)
// and `toMark`, the camera's pixel → photo mark pixel (pixel edges) through its whole
// lens (displayFrame.js makePinholeToMark: the group's own model, any self-calibrated
// terms on top, which no single model holds exactly). Fitted over a grid that covers
// the photo; → { calibration, rmsPx, maxPx } with the misfit in photo pixels.
export function fitMetashapeFrame(toMark, K, width, height, { grid = 24 } = {}) {
  const pts = []
  for (let i = 0; i <= grid; i++) {
    for (let j = 0; j <= grid; j++) {
      const u = -0.5 + (width * i) / grid,
        v = -0.5 + (height * j) / grid
      const m = toMark(u, v)
      if (!Number.isFinite(m?.x) || !Number.isFinite(m?.y)) continue
      if (m.x < -0.05 * width || m.x > 1.05 * width || m.y < -0.05 * height || m.y > 1.05 * height) continue
      pts.push({ x: (u - K.cx) / K.fx, y: (v - K.cy) / K.fy, mx: m.x, my: m.y })
    }
  }
  const c = { f: K.fy, cx: K.cx + 0.5 - width / 2, cy: K.cy + 0.5 - height / 2, k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }
  const residuals = (p) =>
    pts.flatMap((q) => {
      const [u, v] = metashapeProject(p, q.x, q.y, width, height)
      return [u - q.mx, v - q.my]
    })
  // Gauss–Newton with a numeric Jacobian: eight terms, a few hundred points.
  for (let it = 0; it < 20; it++) {
    const r0 = residuals(c)
    const J = FRAME_TERMS.map((k) => {
      const h = k === 'f' || k === 'cx' || k === 'cy' ? 1e-4 : 1e-7
      const r1 = residuals({ ...c, [k]: c[k] + h })
      return r1.map((v, i) => (v - r0[i]) / h)
    })
    const n = FRAME_TERMS.length
    const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => dot(J[a], J[b])))
    const g = J.map((col) => dot(col, r0))
    const step = solve(A, g)
    if (!step) break
    FRAME_TERMS.forEach((k, i) => (c[k] -= step[i]))
    if (Math.max(...step.map(Math.abs)) < 1e-12) break
  }
  const r = residuals(c)
  let sum = 0,
    max = 0
  for (let i = 0; i < r.length; i += 2) {
    const d = Math.hypot(r[i], r[i + 1])
    sum += d * d
    max = Math.max(max, d)
  }
  return { calibration: c, rmsPx: pts.length ? Math.sqrt(sum / pts.length) : 0, maxPx: max }
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0)

// Gaussian elimination with partial pivoting; null when singular.
function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (!(Math.abs(M[p][c]) > 1e-300)) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / row[i])
}

// Geodetic (lon°, lat°, ellipsoidal h) → geocentric X/Y/Z on { a, f }.
export function geodeticToGeocentric([lonDeg, latDeg, h], { a, f }) {
  const e2 = f * (2 - f),
    la = (latDeg * Math.PI) / 180,
    lo = (lonDeg * Math.PI) / 180
  const N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2)
  return [
    (N + h) * Math.cos(la) * Math.cos(lo),
    (N + h) * Math.cos(la) * Math.sin(lo),
    (N * (1 - e2) + h) * Math.sin(la),
  ]
}

const WGS84 = { a: 6378137, f: 1 / 298.257223563 }
// As Metashape 2.2 writes it.
export const WGS84_WKT =
  'GEOGCS["WGS 84",DATUM["World Geodetic System 1984 ensemble",' +
  'SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],TOWGS84[0,0,0,0,0,0,0],' +
  'AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
  'UNIT["degree",0.01745329251994328,AUTHORITY["EPSG","9102"]],AUTHORITY["EPSG","4326"]]'
export const LOCAL_WKT =
  'LOCAL_CS["Local Coordinates (m)",LOCAL_DATUM["Local Datum",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]]]'

// The 4×4 camera → chunk transforms (row-major) of solver cameras { R, t } (world →
// camera, pixel axes), and the chunk transform. Without `geo` the chunk is the export
// frame itself (sim applied, a local frame). With `geo` the chunk is WGS 84 geocentric
// shifted to the block's centroid:
//   geo = { toGeodetic([x, y, z]) → [lon, lat, h ellipsoidal] (export frame → WGS 84),
//           enuToFrame(lon, lat) → 3×3 rotation from east/north/up at that place into
//           the export frame's axes (the grid's convergence there, or a local frame's
//           fixed one) }
// `sim` maps the model into the export frame; `applySim(sim, p)` applies it.
export function metashapeCameraFrames(cameras, sim, applySim, geo = null) {
  const rot = sim
    ? sim.R
    : [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]
  const placed = cameras.map(({ R, t }) => {
    const C = [0, 1, 2].map((j) => -(R[0][j] * t[0] + R[1][j] * t[1] + R[2][j] * t[2]))
    // Camera axes (columns) in the export frame: sim.R · Rᵀ.
    const axes = mul(rot, T(R))
    return { C: sim ? applySim(sim, C) : C, axes }
  })
  if (!geo) {
    return {
      chunk: null,
      transforms: placed.map(({ C, axes }) => matrix4(axes, C)),
    }
  }
  const ecef = placed.map(({ C, axes }) => {
    const [lon, lat, h] = geo.toGeodetic(C)
    const toEcef = mul(T(enuBasis(lon, lat)), T(geo.enuToFrame(lon, lat)))
    return { X: geodeticToGeocentric([lon, lat, h], WGS84), axes: mul(toEcef, axes) }
  })
  const t = [0, 1, 2].map((i) => ecef.reduce((s, e) => s + e.X[i], 0) / Math.max(1, ecef.length))
  return {
    chunk: {
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      t,
      s: 1,
    },
    transforms: ecef.map(({ X, axes }) =>
      matrix4(
        axes,
        X.map((v, i) => v - t[i]),
      ),
    ),
  }
}

const matrix4 = (A, c) => [...A[0], c[0], ...A[1], c[1], ...A[2], c[2], 0, 0, 0, 1]

const esc = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c])
// Element text needs only these; Metashape writes a WKT's quotes as they are.
const escText = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])
const n17 = (v) => (Number.isFinite(v) ? String(Number(v.toPrecision(17))) : '0')
// A fitted term that is only round-off is written as none.
const term = (v) => (Math.abs(v ?? 0) < 1e-12 ? 0 : v)

// The Metashape XML document: what Export Markers writes, so Metashape's File ▸ Import ▸
// Import Cameras reads the calibration and cameras from it, and Import Markers the
// markers. Pixel coordinates are pixel edges, Metashape's and WebSfM's mark convention.
//   sensors  [{ id, label, type: 'frame' | 'fisheye', width, height, pixelSize?, calibration }]
//            (calibration: Metashape's terms: f, cx, cy from W/2, k1–k4, p1, p2)
//   cameras  [{ id, label, sensorId, enabled, transform (16 numbers) }]
//   markers  [{ id, label, reference: { x, y, z, sxy, sz, enabled } | null,
//              locations: [{ cameraId, x, y }] }]
//   chunk    { R, t, s } | null, wkt (the chunk's CRS)
export function buildMetashapeXml({
  sensors = [],
  cameras = [],
  markers = [],
  scalebars = [],
  chunk = null,
  wkt = LOCAL_WKT,
  label = 'WebSfM',
}) {
  const L = ['<?xml version="1.0" encoding="UTF-8"?>', '<document version="2.0.0">']
  L.push(`  <chunk label="${esc(label)}" enabled="true">`)
  L.push(`    <sensors next_id="${sensors.length}">`)
  for (const s of sensors) {
    const c = s.calibration
    L.push(`      <sensor id="${s.id}" label="${esc(s.label)}" type="${s.type ?? 'frame'}">`)
    L.push(`        <resolution width="${s.width}" height="${s.height}"/>`)
    if (s.pixelSize > 0) {
      L.push(`        <property name="pixel_width" value="${n17(s.pixelSize)}"/>`)
      L.push(`        <property name="pixel_height" value="${n17(s.pixelSize)}"/>`)
      L.push(`        <property name="focal_length" value="${n17(c.f * s.pixelSize)}"/>`)
    }
    L.push(`        <calibration type="${s.type ?? 'frame'}" class="adjusted">`)
    L.push(`          <resolution width="${s.width}" height="${s.height}"/>`)
    for (const k of ['f', 'cx', 'cy', 'k1', 'k2', 'k3', 'k4', 'p1', 'p2']) {
      if (k === 'f' || k === 'cx' || k === 'cy' || term(c[k])) L.push(`          <${k}>${n17(term(c[k]))}</${k}>`)
    }
    L.push('        </calibration>')
    L.push('      </sensor>')
  }
  L.push('    </sensors>')
  L.push(`    <cameras next_id="${cameras.length}" next_group_id="0">`)
  for (const c of cameras) {
    L.push(
      `      <camera id="${c.id}" sensor_id="${c.sensorId}" label="${esc(c.label)}"${c.enabled === false ? ' enabled="false"' : ''}>`,
    )
    if (c.transform) L.push(`        <transform>${c.transform.map(n17).join(' ')}</transform>`)
    L.push('      </camera>')
  }
  L.push('    </cameras>')
  L.push(`    <markers next_id="${markers.length}" next_group_id="0">`)
  for (const m of markers) {
    const r = m.reference
    L.push(`      <marker id="${m.id}" label="${esc(m.label)}">`)
    if (r) {
      const acc = [r.sxy != null ? ` sxy="${n17(r.sxy)}"` : '', r.sz != null ? ` sz="${n17(r.sz)}"` : ''].join('')
      L.push(
        `        <reference x="${n17(r.x)}" y="${n17(r.y)}" z="${n17(r.z ?? 0)}"${acc} enabled="${r.enabled ? 'true' : 'false'}"/>`,
      )
    }
    L.push('      </marker>')
  }
  L.push('    </markers>')
  // Scale bars: endpoints { markerId } or { cameraId }, distance and accuracy in metres.
  if (scalebars.length) {
    L.push(`    <scalebars next_id="${scalebars.length}" next_group_id="0">`)
    for (const [i, sb] of scalebars.entries()) {
      L.push(`      <scalebar id="${i}" label="${esc(sb.label)}">`)
      for (const e of [sb.a, sb.b])
        L.push(
          e.markerId != null
            ? `        <endpoint marker_id="${e.markerId}"/>`
            : `        <endpoint camera_id="${e.cameraId}"/>`,
        )
      const acc = sb.accuracy > 0 ? ` accuracy="${n17(sb.accuracy)}"` : ''
      L.push(`        <reference d="${n17(sb.distance)}"${acc} enabled="${sb.enabled === false ? 'false' : 'true'}"/>`)
      L.push('      </scalebar>')
    }
    L.push('    </scalebars>')
  }
  if (chunk) {
    L.push('    <transform>')
    L.push(`      <rotation locked="true">${chunk.R.flat().map(n17).join(' ')}</rotation>`)
    L.push(`      <translation locked="true">${chunk.t.map(n17).join(' ')}</translation>`)
    L.push(`      <scale locked="true">${n17(chunk.s)}</scale>`)
    L.push('    </transform>')
  }
  L.push(`    <reference>${escText(wkt)}</reference>`)
  L.push('    <frames next_id="1">')
  L.push('      <frame id="0">')
  L.push('        <markers>')
  for (const m of markers) {
    if (!m.locations.length) continue
    L.push(`          <marker marker_id="${m.id}">`)
    for (const l of m.locations)
      L.push(`            <location camera_id="${l.cameraId}" pinned="true" x="${n17(l.x)}" y="${n17(l.y)}"/>`)
    L.push('          </marker>')
  }
  L.push('        </markers>')
  L.push('      </frame>')
  L.push('    </frames>')
  L.push('  </chunk>')
  L.push('</document>')
  return L.join('\n') + '\n'
}
