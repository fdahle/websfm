// Cesium 3D Tiles 1.1 output — `tileset.json` plus glTF-binary content. Pure: no
// proj4, no DOM. The caller supplies the geodetic probe points (it owns the CRS
// registry); everything here is ellipsoid maths, glTF packing and JSON.
//
// Scope: **one tile**. That already covers "put my model on the globe", which is
// what the format is usually wanted for. LOD tiling — a quadtree with per-tile
// decimation — is a much larger job and needs a mesh simplifier websfm does not
// have; it is deliberately not started here.
//
// Two conventions are load-bearing and are the whole reason this module exists
// rather than a few lines in the caller:
//
//  1. **Tile content is Y-up, the tile frame is Z-up.** 3D Tiles applies the glTF
//     Y-up→Z-up conversion to content automatically, so vertices are written
//     (east, up, −north) while the bounding volume — which lives in the tile's own
//     coordinate system, before that conversion — stays (east, north, up).
//     Writing both in the same handedness tips the model on its side.
//
//  2. **The ECEF frame is measured, not assumed.** The local east/north axes come
//     from actually projecting two probe points 1 m away in the project CRS. A
//     projected CRS's grid axes are not true east/north — they rotate by the
//     meridian convergence and scale by the point scale factor. Assuming
//     projected ≈ ENU is a common shortcut that is fine in mid-latitudes and badly
//     wrong near the poles, where convergence approaches the longitude difference
//     itself. Measuring absorbs both exactly at the origin.

// WGS84 ellipsoid.
const WGS84_A = 6378137.0
const WGS84_F = 1 / 298.257223563
const WGS84_E2 = WGS84_F * (2 - WGS84_F)

// Geodetic (lon°, lat°, ellipsoidal height m) → earth-centred earth-fixed
// (EPSG:4978) metres — the frame every 3D Tiles transform lands in.
export function geodeticToEcef(lonDeg, latDeg, h = 0) {
  const lon = (lonDeg * Math.PI) / 180
  const lat = (latDeg * Math.PI) / 180
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat)
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat)
  return [
    (N + h) * cosLat * Math.cos(lon),
    (N + h) * cosLat * Math.sin(lon),
    (N * (1 - WGS84_E2) + h) * sinLat,
  ]
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (v) => Math.hypot(v[0], v[1], v[2])

// The tile transform: tile-local (east, north, up) metres → ECEF.
//
// `origin`, `east`, `north` are the SAME point and two probes one project-CRS
// unit away along +x and +y, each as geodetic { lon, lat, h }. The resulting
// basis vectors carry the projection's local rotation and scale, so grid
// distances land as ground distances.
//
// Returns the 16-element **column-major** matrix 3D Tiles wants.
export function ecefTransformFromProbes({ origin, east, north, verticalMetresPerUnit = 1 }) {
  const o = geodeticToEcef(origin.lon, origin.lat, origin.h ?? 0)
  const ex = sub(geodeticToEcef(east.lon, east.lat, east.h ?? origin.h ?? 0), o)
  const ey = sub(geodeticToEcef(north.lon, north.lat, north.h ?? origin.h ?? 0), o)
  if (norm(ex) === 0 || norm(ey) === 0) {
    throw new Error('ecefTransformFromProbes: degenerate probes (the two offsets projected onto the same point)')
  }
  // Up: the direction of ex×ey, but the LENGTH of a vertical unit, not of a grid
  // unit. Heights are not subject to the projection's scale factor k — ex/ey carry
  // 1/k (a grid unit is 1/k ground metres; 1.026 m at 85°S in EPSG:3031), and
  // reusing that length exaggerated every height by the same factor (13 m at 500 m
  // of relief). A vertical unit is `verticalMetresPerUnit` metres (1 for a metric CRS).
  const up = cross(ex, ey)
  const upLen = norm(up)
  const v = verticalMetresPerUnit
  const ez = [up[0] / upLen * v, up[1] / upLen * v, up[2] / upLen * v]
  return [
    ex[0], ex[1], ex[2], 0,
    ey[0], ey[1], ey[2], 0,
    ez[0], ez[1], ez[2], 0,
    o[0], o[1], o[2], 1,
  ]
}

// 3D Tiles `box` bounding volume from an axis-aligned local-frame bbox:
// [cx, cy, cz, hx,0,0, 0,hy,0, 0,0,hz] — centre then three half-axis vectors.
// Stated in the tile's own (Z-up) coordinate system, NOT the glTF content's.
export function boundingBox(min, max) {
  const c = [0, 1, 2].map((i) => (min[i] + max[i]) / 2)
  // A degenerate axis (a perfectly flat cloud) must not produce a zero half-axis:
  // some readers cull a zero-volume box entirely.
  const h = [0, 1, 2].map((i) => Math.max((max[i] - min[i]) / 2, 1e-3))
  return [c[0], c[1], c[2], h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]]
}

// A single-tile tileset. `geometricError` is the screen-space error budget above
// which the tile is drawn; for one tile the value only decides how early it
// loads, so it is derived from the model's own size rather than guessed.
export function buildTileset({ transform, box, contentUri, geometricError }) {
  const err = geometricError ?? Math.max(box[3], box[7], box[11]) * 2
  return {
    asset: { version: '1.1', tilesetVersion: 'websfm' },
    geometricError: err,
    root: {
      boundingVolume: { box },
      geometricError: 0,          // a leaf: no coarser representation exists
      refine: 'REPLACE',
      ...(transform ? { transform } : {}),
      content: { uri: contentUri },
    },
  }
}

// Flat cloud { count, pos, col? } → a glTF-binary POINTS primitive.
//
// `origin` is subtracted first: ECEF-scale coordinates in float32 would quantize
// to metres, and even project-CRS eastings (6–7 digits) lose sub-centimetre
// precision. Local coordinates are small, so float32 is ample.
// `yUp` applies the 3D Tiles content convention (see the header).
export function cloudToGlbPoints(cloud, { origin = [0, 0, 0], yUp = true, color = true } = {}) {
  const n = cloud.count ?? cloud.pos.length / 3
  const hasCol = color && !!cloud.col
  const align4 = (v) => (v + 3) & ~3
  const posBytes = n * 12
  const colBytes = hasCol ? n * 4 : 0
  const posOff = 0
  const colOff = align4(posBytes)
  const binLen = colOff + align4(colBytes)
  const bin = new Uint8Array(binLen)
  const bv = new DataView(bin.buffer)

  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < n; i++) {
    const e = cloud.pos[i * 3] - origin[0]
    const nn = cloud.pos[i * 3 + 1] - origin[1]
    const u = cloud.pos[i * 3 + 2] - origin[2]
    const [x, y, z] = yUp ? [e, u, -nn] : [e, nn, u]
    bv.setFloat32(posOff + i * 12, x, true)
    bv.setFloat32(posOff + i * 12 + 4, y, true)
    bv.setFloat32(posOff + i * 12 + 8, z, true)
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  if (!Number.isFinite(minX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0 }
  if (hasCol) {
    for (let i = 0; i < n; i++) {
      bin[colOff + i * 4] = cloud.col[i * 3]
      bin[colOff + i * 4 + 1] = cloud.col[i * 3 + 1]
      bin[colOff + i * 4 + 2] = cloud.col[i * 3 + 2]
      bin[colOff + i * 4 + 3] = 255
    }
  }

  const accessors = [{
    bufferView: 0, componentType: 5126, count: n, type: 'VEC3',
    min: [minX, minY, minZ], max: [maxX, maxY, maxZ],
  }]
  const bufferViews = [{ buffer: 0, byteOffset: posOff, byteLength: posBytes, target: 34962 }]
  const attributes = { POSITION: 0 }
  if (hasCol) {
    attributes.COLOR_0 = accessors.length
    accessors.push({ bufferView: bufferViews.length, componentType: 5121, normalized: true, count: n, type: 'VEC4' })
    bufferViews.push({ buffer: 0, byteOffset: colOff, byteLength: colBytes, target: 34962 })
  }

  return packGlb({
    asset: { version: '2.0', generator: 'websfm' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, mode: 0 }] }],   // mode 0 = POINTS
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLen }],
  }, bin)
}

// glTF JSON + BIN → a .glb container. Shared shape with meshToGlb's tail; kept
// here so this module has no dependency on the mesh exporter.
export function packGlb(gltf, bin) {
  const enc = new TextEncoder()
  let jsonBytes = enc.encode(JSON.stringify(gltf))
  const jsonPad = (4 - (jsonBytes.length & 3)) & 3
  if (jsonPad) {
    const p = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20)
    p.set(jsonBytes)
    jsonBytes = p
  }
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true)   // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true)  // 'JSON'
  out.set(jsonBytes, 20)
  const binHdr = 20 + jsonBytes.length
  dv.setUint32(binHdr, bin.length, true)
  dv.setUint32(binHdr + 4, 0x004e4942, true) // 'BIN\0'
  out.set(bin, binHdr + 8)
  return out
}

// Local-frame bbox of a flat cloud, relative to `origin`, in the tile's Z-up
// coordinate system (so it pairs with `boundingBox`, not with the glTF content).
export function localBounds(cloud, origin = [0, 0, 0]) {
  const n = cloud.count ?? cloud.pos.length / 3
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = cloud.pos[i * 3 + a] - origin[a]
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min, max }
}

// Centroid of a flat cloud — the natural tile origin (see cloudToGlbPoints on
// why an origin is needed at all).
export function cloudCentroid(cloud) {
  const n = cloud.count ?? cloud.pos.length / 3
  if (!n) return [0, 0, 0]
  let sx = 0, sy = 0, sz = 0
  for (let i = 0; i < n; i++) {
    sx += cloud.pos[i * 3]; sy += cloud.pos[i * 3 + 1]; sz += cloud.pos[i * 3 + 2]
  }
  return [sx / n, sy / n, sz / n]
}
