// What right-click ▸ Show information lists for a sidebar row: a cloud (sparse,
// dense, mesh), a raster product (DEM, orthophoto), a reference raster, a vector
// layer, a sensor, a control point or the matches. The record's own facts as
// label/value rows. Pure: the dialog passes the record and the little project
// context a row needs.

import { pluralize } from '../textFormat.js'
import { isGeographic, linearCrsUnit } from '../crs.js'

const num = (n) => (Number.isFinite(n) ? n.toLocaleString() : null)
const created = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : null)
const unitOf = (p) => (p?.unit && p.unit !== 'model' ? p.unit : 'model units')
const frameOf = (p) => (!p?.crs || p.crs === 'local' ? 'Local' : p.crs)
// Rows with no value are left out: an older record lacks the newer fields.
const keep = (rows) => rows.filter((r) => r.value != null && r.value !== '')

// The DEM and Orthophoto dialogs' own option labels, short.
const FILL = { idw: 'Inverse distance', nearest: 'Nearest neighbour', none: 'None (gaps kept)' }
const BLEND = { mosaic: 'Mosaic', best: 'Best match', average: 'Average' }
const SEAMLINE = { graphcut: 'Graph cut', nadir: 'Most nadir photo' }
const label = (table, id) => (id == null ? null : (table[id] ?? String(id)))
const onOff = (b) => (b == null ? null : b ? 'On' : 'Off')

const CLOUD_TYPE = { sparse: 'Sparse cloud', dense: 'Dense cloud', mesh: 'Mesh' }

/**
 * @param {object} cloud a clouds[] record
 * @param {{ isMain?: boolean, outdated?: string|null, imageCount?: number, summary?: object|null }} [ctx]
 *   `summary`: the last sparse run's record, passed for the main sparse cloud only;
 *   `outdated`: why it is outdated (the store's productStatus), or null.
 * @returns {{ title: string, rows: { label: string, value: string }[] }}
 */
export function cloudInfo(cloud, ctx = {}) {
  const roles = [ctx.isMain && 'main', cloud.imported && 'imported', cloud.derived && 'derived']
  const rows = [
    { label: 'Type', value: `${CLOUD_TYPE[cloud.kind] ?? cloud.kind}${tagList(roles)}` },
    { label: 'Outdated', value: ctx.outdated ? capitalised(ctx.outdated) : null },
  ]
  if (cloud.kind === 'sparse') rows.push(...sparseRows(cloud, ctx))
  else if (cloud.kind === 'dense') rows.push(...denseRows(cloud))
  else if (cloud.kind === 'mesh') rows.push(...meshRows(cloud))
  rows.push({ label: 'Created', value: created(cloud.createdAt) })
  return { title: cloud.name || CLOUD_TYPE[cloud.kind], rows: keep(rows) }
}

const capitalised = (s) => s.charAt(0).toUpperCase() + s.slice(1)

function tagList(tags) {
  const t = tags.filter(Boolean)
  return t.length ? ` (${t.join(', ')})` : ''
}

function sparseRows(cloud, { imageCount, summary }) {
  const pts = cloud.points
  let tie = 0
  let obs = 0
  for (let i = 0; i < (pts?.length ?? 0); i++) {
    const v = pts.vcount[i]
    if (v > 0) {
      tie++
      obs += v
    }
  }
  const cams = cloud.cameras?.size ?? 0
  return [
    { label: 'Cameras', value: imageCount ? `${num(cams)} of ${pluralize(imageCount, 'image')}` : num(cams) },
    { label: 'Points', value: num(pts?.length ?? 0) },
    { label: 'Tie-points', value: num(tie) },
    { label: 'Mean track length', value: tie ? `${(obs / tie).toFixed(2)} views` : null },
    {
      label: 'Reprojection error',
      value: Number.isFinite(summary?.postBaMedianPx) ? `${summary.postBaMedianPx.toFixed(2)} px (median)` : null,
    },
  ]
}

function denseRows(cloud) {
  const storage =
    cloud.lod && !cloud.pos
      ? cloud.lod.format === 'copc'
        ? 'Read in place from its COPC file'
        : 'Streamed from its octree'
      : 'In memory'
  const attrs = Object.keys(cloud.attributes ?? {})
  return [
    { label: 'Points', value: num(cloud.count ?? 0) },
    { label: 'Colours', value: cloud.col || cloud.lod ? 'Yes' : 'No' },
    { label: 'Normals', value: cloud.nrm ? 'Yes' : 'No' },
    { label: 'Attributes', value: attrs.length ? attrs.join(', ') : null },
    { label: 'Storage', value: storage },
  ]
}

function meshRows(cloud) {
  const s = cloud.meshSummary
  return [
    { label: 'Triangles', value: num(cloud.count ?? 0) },
    { label: 'Vertices', value: num(cloud.nVerts ?? 0) },
    { label: 'Texture', value: cloud.texture ? 'Yes' : 'No (vertex colours)' },
    { label: 'Source', value: s?.sourceName ?? null },
    { label: 'Octree depth', value: s?.depth != null ? String(s.depth) : null },
    { label: 'Trim', value: s?.trim ?? null },
    { label: 'Build time', value: s?.totalMs ? `${(s.totalMs / 1000).toFixed(1)} s` : null },
  ]
}

/**
 * @param {'dem'|'ortho'} kind
 * @param {object} p the product record (one of recon.rasterProducts)
 * @param {{ isMain?: boolean, outdated?: string|null }} [ctx] as for cloudInfo
 * @returns {{ title: string, rows: { label: string, value: string }[] }}
 */
export function rasterInfo(kind, p, ctx = {}) {
  const unit = unitOf(p)
  const extent =
    p.gsd > 0 && p.width && p.height
      ? `${(p.width * p.gsd).toPrecision(4)} × ${(p.height * p.gsd).toPrecision(4)} ${unit}`
      : null
  const rows = [
    {
      label: 'Type',
      value:
        (kind === 'dem' ? (p.points === 'ground' ? 'DTM (ground only)' : 'DEM (surface)') : 'Orthophoto') +
        (ctx.isMain ? ' (main)' : ''),
    },
    { label: 'Outdated', value: ctx.outdated ? capitalised(ctx.outdated) : null },
    { label: 'Frame', value: frameOf(p) },
    { label: 'Size', value: p.width && p.height ? `${num(p.width)} × ${num(p.height)} px` : null },
    { label: 'GSD', value: p.gsd > 0 ? `${p.gsd.toPrecision(3)} ${unit}/px` : null },
    { label: 'Extent', value: extent },
  ]
  if (kind === 'dem') {
    rows.push(
      { label: 'Source', value: p.source?.name ? `${p.source.name} (${p.source.kind})` : null },
      {
        label: 'Elevation',
        value:
          Number.isFinite(p.zMin) && Number.isFinite(p.zMax)
            ? `${p.zMin.toPrecision(5)} – ${p.zMax.toPrecision(5)} ${unit}`
            : null,
      },
      { label: 'Vertical datum', value: p.verticalDatum ?? null },
      { label: 'Gap fill', value: label(FILL, p.fillMethod) },
    )
  } else {
    const cells = p.width * p.height
    rows.push(
      { label: 'Surface', value: p.surface ?? null },
      { label: 'Coverage', value: p.covered != null && cells ? `${Math.round((100 * p.covered) / cells)}%` : null },
    )
    const blend = p.method?.blend ?? p.blend ?? null
    rows.push(
      { label: 'Blend', value: label(BLEND, blend) },
      // Seams and gains are the mosaic's alone.
      ...(blend === 'mosaic'
        ? [
            { label: 'Seamlines', value: label(SEAMLINE, p.method?.seamline) },
            { label: 'Colour balance', value: onOff(p.method?.colourBalance) },
          ]
        : []),
    )
  }
  rows.push({ label: 'Created', value: created(p.createdAt) })
  return { title: p.name || (kind === 'dem' ? 'DEM' : 'Orthophoto'), rows: keep(rows) }
}

// ── The other sidebar rows: reference rasters, vector layers, sensors, points, matches ──

const unitOfCrs = (crs) => (!crs ? null : isGeographic(crs) ? '°' : linearCrsUnit(crs))
const withUnit = (v, unit, digits = 3) =>
  Number.isFinite(v) ? `${v.toPrecision(digits)}${unit ? ` ${unit}` : ''}` : null
const ORIGIN = { sentinel2: 'Fetched from Sentinel-2 (Find GCPs)' }

/**
 * An imported (or fetched) reference raster: a useExternalStore record.
 * @param {object} r
 * @returns {{ title: string, rows: { label: string, value: string }[] }}
 */
export function referenceRasterInfo(r) {
  const unit = unitOfCrs(r.crs)
  const gsd = Math.abs(r.geoTransform?.scaleX)
  const w = r.window
  const rows = [
    { label: 'Type', value: r.kind === 'dem' ? 'Reference DEM' : 'Reference orthophoto' },
    { label: 'Source', value: ORIGIN[r.origin] ?? 'Imported file' },
    { label: 'CRS', value: r.crs ? `${r.crs}${r.crsUnresolved ? ' (could not be resolved)' : ''}` : 'Unknown' },
    { label: 'Size', value: r.width && r.height ? `${num(r.width)} × ${num(r.height)} px` : null },
    {
      label: 'Window',
      value: w ? `Read over the project from ${num(w.fullWidth)} × ${num(w.fullHeight)} px` : null,
    },
    { label: 'GSD', value: gsd > 0 ? `${withUnit(gsd, unit)}/px` : null },
    {
      label: 'Extent',
      value:
        gsd > 0 && r.width && r.height
          ? `${withUnit(r.width * gsd, unit, 4)} × ${withUnit(r.height * gsd, unit, 4)}`
          : null,
    },
    {
      label: 'Bands',
      value: r.bands ? `${r.bands}${r.bitsPerSample ? ` × ${[r.bitsPerSample].flat()[0]}-bit` : ''}` : null,
    },
    { label: 'σ horizontal', value: withUnit(r.horizontalAccuracy, 'm') },
  ]
  if (r.kind === 'dem')
    rows.push(
      {
        label: 'Elevation',
        value:
          Number.isFinite(r.zMin) && Number.isFinite(r.zMax)
            ? `${r.zMin.toPrecision(5)} – ${r.zMax.toPrecision(5)}`
            : null,
      },
      {
        label: 'Vertical datum',
        value: r.verticalDatum && r.verticalDatum !== 'unknown' ? r.verticalDatum : 'Unknown',
      },
      { label: 'σ vertical', value: withUnit(r.verticalAccuracy, '') },
      { label: 'Vertical offset', value: r.vOffset ? String(r.vOffset) : null },
    )
  rows.push({ label: 'Imported', value: created(r.importedAt) })
  return { title: r.name || 'Reference raster', rows: keep(rows) }
}

/**
 * A vector layer (useFootprintsStore set): an imported polygon file or contour lines.
 * @param {object} set
 * @param {{ crs?: string|null }} [ctx] `crs`: the project CRS, which the layer is stored in.
 */
export function vectorSetInfo(set, ctx = {}) {
  const lines = set.kind === 'lines'
  const features = set.footprints ?? []
  let vertices = 0
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity
  for (const f of features)
    for (const path of (lines ? f.lines : f.rings) ?? [])
      for (const [x, y] of path) {
        vertices++
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  const unit = unitOfCrs(ctx.crs)
  const levels = lines ? features.map((f) => f.level).filter(Number.isFinite) : []
  const sorted = [...new Set(levels)].sort((a, b) => a - b)
  const linked = features.filter((f) => f.imageId).length
  const rows = [
    { label: 'Type', value: lines ? 'Lines' : 'Polygons' },
    {
      label: 'Source',
      value: set.source === 'imported' ? 'Imported file' : lines ? 'Contours from the DEM' : 'Computed',
    },
    { label: lines ? 'Lines' : 'Polygons', value: num(features.length) },
    { label: 'Vertices', value: num(vertices) },
    { label: 'Linked to images', value: lines ? null : `${num(linked)} of ${num(features.length)}` },
    {
      label: 'Levels',
      value: sorted.length
        ? `${sorted[0]} – ${sorted[sorted.length - 1]} (${pluralize(sorted.length, 'level')})`
        : null,
    },
    { label: 'Extent', value: vertices > 1 ? `${withUnit(x1 - x0, unit, 4)} × ${withUnit(y1 - y0, unit, 4)}` : null },
    { label: 'CRS', value: ctx.crs ?? null },
    { label: 'Imported in', value: set.sourceCrs && set.sourceCrs !== ctx.crs ? set.sourceCrs : null },
    { label: 'Created', value: created(set.createdAt) },
  ]
  return { title: set.name || (lines ? 'Lines' : 'Polygons'), rows: keep(rows) }
}

const fixed = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)).toLocaleString() : null)

/**
 * A sensor (camera model) record of useSensorsStore.
 * @param {object} s
 * @param {{ imageCount?: number, incomplete?: boolean, lens?: string|null }} [ctx]
 *   `lens`: the lens model's label when it changes anything (SensorsSection's lensLabel).
 */
export function sensorInfo(s, ctx = {}) {
  const coeffs = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2']
    .filter((k) => Number.isFinite(s[k]) && s[k] !== 0)
    .map((k) => `${k} ${s[k].toPrecision(3)}`)
  const rows = [
    { label: 'Source', value: s.source === 'exif' ? 'EXIF' : 'Imported calibration' },
    { label: 'Images', value: ctx.imageCount != null ? num(ctx.imageCount) : null },
    { label: 'Dimensions', value: s.width && s.height ? `${num(s.width)} × ${num(s.height)} px` : null },
    {
      label: 'Focal length',
      value: Number.isFinite(s.focal) ? `${fixed(s.focal, 2)} ${s.focalUnit || 'px'}` : 'Not set',
    },
    { label: 'Principal point', value: Number.isFinite(s.cx) ? `${fixed(s.cx, 1)}, ${fixed(s.cy, 1)} px` : null },
    { label: 'Pixel size', value: Number.isFinite(s.pixelSize) && s.pixelSize > 0 ? `${s.pixelSize} µm` : null },
    { label: 'Lens', value: ctx.lens ?? 'Pinhole (none)' },
    { label: 'Coefficients', value: coeffs.length ? coeffs.join(', ') : null },
    {
      label: 'Calibration',
      value: ctx.incomplete ? 'Incomplete: a default field of view is assumed' : null,
    },
  ]
  return { title: s.label || 'Sensor', rows: keep(rows) }
}

const ROLE = { control: 'Control point', check: 'Checkpoint', marker: 'Marker (scale-bar endpoint)' }

/**
 * A control point, checkpoint or marker (useGcpsStore record).
 * @param {object} g
 * @param {{ crs?: string|null, report?: object|null }} [ctx]
 *   `report`: its row of the GCP accuracy report (dx, dy, dz, dTotal, observations), or null.
 */
export function gcpInfo(g, ctx = {}) {
  const marker = g.role === 'marker'
  const unit = unitOfCrs(ctx.crs) ?? ''
  const coord = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)) : null)
  const rep = ctx.report
  const reproj = (rep?.observations ?? []).map((o) => o.reprojPx).filter(Number.isFinite)
  const marks = g.observations?.length ?? 0
  const sx = g.accuracyX
  const sy = g.accuracyY
  const rows = [
    { label: 'Type', value: `${ROLE[g.role] ?? ROLE.control}${g.enabled === false ? ' (disabled)' : ''}` },
    { label: 'X', value: marker ? null : coord(g.x) },
    { label: 'Y', value: marker ? null : coord(g.y) },
    { label: 'Z', value: marker ? null : (coord(g.z) ?? 'None') },
    { label: 'CRS', value: marker ? null : (ctx.crs ?? null) },
    {
      label: 'σ X / Y / Z',
      value:
        !marker && [sx, sy, g.accuracyZ].some(Number.isFinite)
          ? [sx, sy, g.accuracyZ].map((v) => (Number.isFinite(v) ? v.toPrecision(3) : '—')).join(' / ') + ` ${unit}`
          : null,
    },
    { label: 'Marked images', value: `${num(marks)}${marks < 2 ? ' (needs at least 2)' : ''}` },
    {
      label: 'Residual',
      value: !marker && Number.isFinite(rep?.dTotal) ? `${withUnit(rep.dTotal, unit)}` : null,
    },
    {
      label: 'Residual X / Y / Z',
      value:
        !marker && [rep?.dx, rep?.dy, rep?.dz].every(Number.isFinite)
          ? [rep.dx, rep.dy, rep.dz].map((v) => v.toPrecision(3)).join(' / ')
          : null,
    },
    {
      label: 'Reprojection error',
      value: reproj.length ? `${(reproj.reduce((a, b) => a + b, 0) / reproj.length).toFixed(2)} px (mean)` : null,
    },
    { label: 'Triangulated', value: rep ? (rep.sfm ? 'Yes' : 'No: needs 2 marks in aligned images') : null },
  ]
  return { title: g.name || 'Point', rows: keep(rows) }
}

/**
 * The project's pairwise matches.
 * @param {Map<string, object>} matchStore pair id → { status, inlierCount, enabled, weak }
 * @param {object} stats core/eval/usedMatches.js matchPairStats
 * @param {{ imageCount?: number }} [ctx]
 */
export function matchesInfo(matchStore, stats, ctx = {}) {
  const inliers = []
  const linked = new Set()
  for (const [pid, e] of matchStore) {
    if (e.status !== 'done' || !(e.inlierCount > 0) || e.enabled === false || e.weak) continue
    inliers.push(e.inlierCount)
    for (const uuid of pid.split('--')) linked.add(uuid)
  }
  inliers.sort((a, b) => a - b)
  const total = inliers.reduce((a, b) => a + b, 0)
  const rows = [
    { label: 'Pairs tried', value: num(stats.total) },
    { label: 'Verified pairs', value: num(stats.verified) },
    { label: 'Used in model', value: stats.used != null ? num(stats.used) : null },
    { label: 'Weak', value: stats.weak ? num(stats.weak) : null },
    { label: 'Excluded', value: stats.excluded ? num(stats.excluded) : null },
    { label: 'Failed', value: stats.error ? num(stats.error) : null },
    { label: 'Running', value: stats.running ? num(stats.running) : null },
    { label: 'Inlier matches', value: total ? num(total) : null },
    { label: 'Median per pair', value: inliers.length ? num(inliers[inliers.length >> 1]) : null },
    {
      label: 'Images in a pair',
      value: ctx.imageCount ? `${num(linked.size)} of ${pluralize(ctx.imageCount, 'image')}` : null,
    },
  ]
  return { title: 'Matches', rows: keep(rows) }
}
