// What right-click ▸ Show information lists for a cloud (sparse, dense, mesh) or a
// raster product (DEM, orthophoto): the record's own facts as label/value rows.
// Pure: the dialog passes the record and the little project context a row needs.

import { pluralize } from '../textFormat.js'

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
