// Minimal ASCII DXF writer — pure, no Vue/Pinia/OPFS/DOM. Emits AutoCAD R12
// (AC1009), the dialect every CAD/GIS reader still accepts: HEADER (version +
// extents), TABLES (LTYPE CONTINUOUS + LAYER), ENTITIES (POLYLINE/VERTEX/SEQEND
// and POINT), EOF. Returns a string; the UI wraps it in a Blob.
//
// R12 has no LWPOLYLINE, so every polyline is a POLYLINE…SEQEND sequence:
//   - a 2D polyline (flag 0) when the caller gives `elevation`, or when every
//     vertex carries the same z (missing z counts as 0). Its elevation is the z
//     of the POLYLINE's own 10/20/30 point — R12's spelling; group code 38 is the
//     LWPOLYLINE elevation of R14+ and an R12 reader would not look for it. The
//     vertices repeat the elevation in their 30 so readers that take vertex z
//     verbatim agree with readers that take the header's.
//   - a 3D polyline (flag 8, vertex flag 32) otherwise.
// Closed adds flag 1; the first vertex is NOT repeated at the end.
//
// Numbers are fixed-point (`precision` decimals, trailing zeros trimmed), never
// exponent notation: survey coordinates are ~1e6 m and `String(v)` would still
// be fine there, but a tiny value would print as `1e-7`, which some readers
// reject. Layer names are upper-cased and reduced to R12's [A-Z0-9_$-], ≤31
// chars; a layer an entity references but the caller did not declare is added
// (colour 7). Non-finite coordinates throw — a NaN in a DXF corrupts the file
// silently in most readers.

const MAX_LAYER_NAME = 31

// R12 layer-name rules. '0' is the always-present default layer.
export function dxfLayerName(name) {
  const s = String(name ?? '0').toUpperCase().replace(/[^A-Z0-9_$-]/g, '_').slice(0, MAX_LAYER_NAME)
  return s.length ? s : '0'
}

// Fixed-point, trimmed, always with one decimal ("12.0"), "-0" folded to "0".
export function formatDxfNumber(v, precision = 6) {
  if (!Number.isFinite(v)) throw new Error(`DXF: non-finite coordinate (${v})`)
  let s = v.toFixed(precision)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0')
  if (/^-0(\.0)?$/.test(s)) s = '0.0'
  return s
}

// Write a DXF document.
//   doc: {
//     layers?:    [{ name, color? /* ACI 1–255, default 7 */ }]
//     polylines?: [{ layer, points: [[x,y,z?],…], closed?, elevation? }]
//     points?:    [{ layer, x, y, z? }]
//   }
//   opts.precision — decimals for coordinates (default 6)
// Returns the DXF text (LF line endings). A polyline with < 2 vertices is
// skipped (R12 readers reject a one-vertex POLYLINE); write it as a point.
export function writeDxf(doc = {}, { precision = 6 } = {}) {
  const polylines = doc.polylines ?? []
  const points = doc.points ?? []
  const out = []
  const g = (code, value) => { out.push(String(code).padStart(3), String(value)) }
  const num = (v) => formatDxfNumber(v, precision)

  // Layers: declared first (caller order), then any referenced-but-undeclared.
  const layers = new Map()
  const addLayer = (name, color) => {
    const key = dxfLayerName(name)
    if (!layers.has(key)) {
      const c = Number.isInteger(color) && color >= 1 && color <= 255 ? color : 7
      layers.set(key, c)
    }
    return key
  }
  addLayer('0', 7)
  for (const l of doc.layers ?? []) addLayer(l.name, l.color)

  // Extents over every coordinate written.
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  const grow = (x, y, z) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  // Resolve every polyline before writing so the header extents are known.
  const resolved = []
  for (const pl of polylines) {
    const pts = pl.points ?? []
    if (pts.length < 2) continue
    const layer = addLayer(pl.layer)
    let flat = Number.isFinite(pl.elevation)
    let elev = flat ? pl.elevation : (pts[0][2] ?? 0)
    if (!flat) {
      flat = true
      for (let i = 1; i < pts.length; i++) if ((pts[i][2] ?? 0) !== elev) { flat = false; break }
    }
    const verts = new Array(pts.length)
    for (let i = 0; i < pts.length; i++) {
      const z = flat ? elev : (pts[i][2] ?? 0)
      verts[i] = [pts[i][0], pts[i][1], z]
      grow(pts[i][0], pts[i][1], z)
    }
    if (!flat) elev = 0
    resolved.push({ layer, verts, flat, elev, closed: !!pl.closed })
  }
  const resolvedPoints = []
  for (const p of points) {
    const z = p.z ?? 0
    resolvedPoints.push({ layer: addLayer(p.layer), x: p.x, y: p.y, z })
    grow(p.x, p.y, z)
  }
  if (!(minX <= maxX)) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0 }

  // HEADER
  g(0, 'SECTION'); g(2, 'HEADER')
  g(9, '$ACADVER'); g(1, 'AC1009')
  g(9, '$EXTMIN'); g(10, num(minX)); g(20, num(minY)); g(30, num(minZ))
  g(9, '$EXTMAX'); g(10, num(maxX)); g(20, num(maxY)); g(30, num(maxZ))
  g(0, 'ENDSEC')

  // TABLES: LTYPE (CONTINUOUS, which every layer references) + LAYER
  g(0, 'SECTION'); g(2, 'TABLES')
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1)
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0')
  g(0, 'ENDTAB')
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.size)
  for (const [name, color] of layers) {
    g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, 'CONTINUOUS')
  }
  g(0, 'ENDTAB')
  g(0, 'ENDSEC')

  // ENTITIES
  g(0, 'SECTION'); g(2, 'ENTITIES')
  for (const pl of resolved) {
    g(0, 'POLYLINE'); g(8, pl.layer); g(66, 1)
    g(10, '0.0'); g(20, '0.0'); g(30, num(pl.elev))
    g(70, (pl.flat ? 0 : 8) | (pl.closed ? 1 : 0))
    for (const [x, y, z] of pl.verts) {
      g(0, 'VERTEX'); g(8, pl.layer)
      g(10, num(x)); g(20, num(y)); g(30, num(z))
      g(70, pl.flat ? 0 : 32)
    }
    g(0, 'SEQEND'); g(8, pl.layer)
  }
  for (const p of resolvedPoints) {
    g(0, 'POINT'); g(8, p.layer); g(10, num(p.x)); g(20, num(p.y)); g(30, num(p.z))
  }
  g(0, 'ENDSEC')
  g(0, 'EOF')
  return out.join('\n') + '\n'
}
