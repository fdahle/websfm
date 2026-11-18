// Aligned photos as Georeference Annotations (the IIIF georeference extension,
// https://iiif.io/api/extension/georef/), the format Allmaps reads: Allmaps Viewer
// warps each photo from its IIIF image server with these control points. Pure: no
// Vue, Pinia, OPFS or DOM.
//
// One annotation per photo, all in one AnnotationPage. The control points are the
// photo's ground grid (products/photoGrid.js): a photo pixel and where its ray meets
// the ground, in WGS 84 longitude/latitude, with a thin plate spline, which passes
// through every point, so the warp keeps the relief and the lens the grid follows.
// The mask (an SvgSelector polygon) is the outline of the grid's landed nodes: the
// photo's pinhole frame (a film scan's fiducial frame), minus what lies past the
// horizon. Coordinates are in the full-size photo's pixels, its top-left corner at
// (0, 0), as IIIF counts them; the IIIF image must be that photo at that size.

import { EXPORT_DEFAULTS } from '../defaults.user.js'

/**
 * Where a project's photos are served from, as the project keeps it for its next
 * Export ▸ Allmaps: { template, version }, or null when none was given (absent in an
 * older project, or malformed).
 */
export function normalizeIiifImages(raw) {
  if (!raw || typeof raw !== 'object') return null
  const template = typeof raw.template === 'string' ? raw.template.trim() : ''
  if (!template) return null
  const version = Number(raw.version) === 3 ? 3 : Number(raw.version) === 2 ? 2 : EXPORT_DEFAULTS.iiifVersion
  return { template, version }
}

/** The IIIF Image API service types an annotation names, by API version. */
export const IIIF_SERVICE_TYPES = { 2: 'ImageService2', 3: 'ImageService3' }

const PLACEHOLDER_RE = /\{(name|stem)\}/g

/**
 * Why `template` cannot address the photos, as a message key, or '' when it can:
 * empty, not an http(s) address, or (for more than one photo) without a {name} or
 * {stem} that tells the photos apart.
 */
export function iiifTemplateProblem(template, photoCount = 1) {
  const t = String(template ?? '').trim()
  if (!t) return 'empty'
  if (!/^https?:\/\/[^/\s]+/i.test(t)) return 'notUrl'
  if (photoCount > 1 && !t.match(PLACEHOLDER_RE)) return 'noPlaceholder'
  return ''
}

/**
 * A photo's IIIF image address: `template` with {name} replaced by the photo's file
 * name and {stem} by the name without its extension, each URI-encoded (a "/" in a name
 * becomes %2F, as IIIF identifiers need). A trailing "/" or "/info.json" is dropped:
 * the annotation names the image service itself.
 */
export function iiifImageUri(template, name) {
  const stem = String(name).replace(/\.[^./]*$/, '')
  return String(template)
    .trim()
    .replace(PLACEHOLDER_RE, (_, key) => encodeURIComponent(key === 'name' ? name : stem))
    .replace(/\/info\.json$/i, '')
    .replace(/\/+$/, '')
}

const round = (v, digits) => {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

/**
 * The outline of a ground grid's landed nodes, in the photo's pixels ([[x, y]], not
 * closed): down the first landed node of each row, along the last landed row, up the
 * last landed node of each row, back along the first landed row. For a grid whose
 * nodes all landed, that is the frame's border through every edge node. Rows with no
 * landed node are skipped; a row's landed nodes are taken as one run (the horizon cuts
 * a photo along a line). Fewer than two landed rows, or three points: null.
 */
export function gridOutline({ cells, src, dst }, width, height) {
  const n = cells + 1
  const rows = []
  for (let j = 0; j < n; j++) {
    let lo = -1,
      hi = -1
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(dst[2 * (j * n + i)])) continue
      if (lo < 0) lo = i
      hi = i
    }
    if (lo >= 0) rows.push({ j, lo, hi })
  }
  if (rows.length < 2) return null
  const first = rows[0],
    last = rows[rows.length - 1]
  const ring = []
  for (const r of rows) ring.push([r.j, r.lo]) // down the left
  for (let i = last.lo + 1; i <= last.hi; i++) ring.push([last.j, i]) // along the bottom
  for (let k = rows.length - 2; k >= 0; k--) ring.push([rows[k].j, rows[k].hi]) // up the right
  for (let i = first.hi - 1; i > first.lo; i--) ring.push([first.j, i]) // back along the top
  const nodes = ring.map(([j, i]) => j * n + i).filter((k, idx, all) => k !== all[idx - 1])
  if (nodes.length > 1 && nodes[nodes.length - 1] === nodes[0]) nodes.pop()
  if (nodes.length < 3) return null
  return nodes.map((k) => [round(src[2 * k] * width, 2), round(src[2 * k + 1] * height, 2)])
}

/**
 * One photo's Georeference Annotation.
 *   grid       its ground grid in the project CRS (photoGrid.js photoGroundGrid)
 *   width, height   the full-size photo, in pixels
 *   uri        its IIIF image service (iiifImageUri)
 *   version    the IIIF Image API version the server speaks (2 or 3)
 *   toLonLat   [x, y] in the project CRS → [longitude, latitude]
 * → the annotation, or null when fewer than three nodes landed (no warp is defined).
 */
export function georeferenceAnnotation({ grid, width, height, uri, version = 2, toLonLat }) {
  const features = []
  const nodes = (grid.cells + 1) ** 2
  for (let k = 0; k < nodes; k++) {
    const x = grid.dst[2 * k],
      y = grid.dst[2 * k + 1]
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    const [lon, lat] = toLonLat([x, y])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    features.push({
      type: 'Feature',
      properties: { resourceCoords: [round(grid.src[2 * k] * width, 2), round(grid.src[2 * k + 1] * height, 2)] },
      geometry: { type: 'Point', coordinates: [round(lon, 9), round(lat, 9)] },
    })
  }
  const outline = gridOutline(grid, width, height)
  if (features.length < 3 || !outline) return null
  const points = outline.map(([x, y]) => `${x},${y}`).join(' ')
  return {
    'type': 'Annotation',
    '@context': [
      'http://iiif.io/api/extension/georef/1/context.json',
      'http://iiif.io/api/presentation/3/context.json',
    ],
    'motivation': 'georeferencing',
    'target': {
      type: 'SpecificResource',
      source: { id: uri, type: IIIF_SERVICE_TYPES[version] ?? IIIF_SERVICE_TYPES[2], width, height },
      selector: {
        type: 'SvgSelector',
        value: `<svg width="${width}" height="${height}"><polygon points="${points}" /></svg>`,
      },
    },
    'body': { type: 'FeatureCollection', transformation: { type: 'thinPlateSpline' }, features },
  }
}

/** Annotations as one AnnotationPage, the file Allmaps Viewer opens. */
export function annotationPage(annotations) {
  return { 'type': 'AnnotationPage', '@context': 'http://www.w3.org/ns/anno.jsonld', 'items': annotations }
}
