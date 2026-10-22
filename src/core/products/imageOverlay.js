// Source images drawn on the 2D map, each into its footprint (View ▸ Map ▸ Images).
// Pure geometry; components/viewers/map/mapImageLayer.js draws with it.
//
// A computed footprint is the four image corners cast onto the ground, in the order
// top-left, top-right, bottom-right, bottom-left (core/footprint.js). The plane
// projective map (homography) from the image rectangle onto that quadrilateral puts
// every pixel where a flat-ground projection of the photo would land: exact for a
// footprint on a plane, and as close as the footprint itself for one on terrain (its
// corners are on the ground, its edges straight). A 2D canvas draws only affine maps,
// so the image is cut into a mesh of triangles, each drawn with the affine map of its
// three corners; with a few cells a side the piecewise-affine image is within a
// fraction of a screen pixel of the projective one.

/**
 * The homography from the unit square onto `quad` ([[x, y] × 4]: the images of
 * (0,0), (1,0), (1,1), (0,1)), Heckbert's square-to-quad: → (u, v) → [x, y].
 */
export function squareToQuad(quad) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2,
    dy2 = y3 - y2,
    dy3 = y0 - y1 + y2 - y3
  let g = 0,
    h = 0
  if (dx3 !== 0 || dy3 !== 0) {
    const den = dx1 * dy2 - dx2 * dy1
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
  }
  const a = x1 - x0 + g * x1,
    b = x3 - x0 + h * x3,
    d = y1 - y0 + g * y1,
    e = y3 - y0 + h * y3
  return (u, v) => {
    const w = g * u + h * v + 1
    return [(a * u + b * v + x0) / w, (d * u + e * v + y0) / w]
  }
}

/**
 * The image's warp mesh: `n`×`n` cells over the unit square, two triangles each, as
 * { src: [[u, v] × 3] (0–1), dst: [[x, y] × 3] (map coordinates) }.
 */
export function warpMesh(quad, n) {
  const H = squareToQuad(quad)
  const at = []
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) at.push(H(i / n, j / n))
  const uv = (i, j) => [i / n, j / n]
  const xy = (i, j) => at[j * (n + 1) + i]
  const out = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      out.push({ src: [uv(i, j), uv(i + 1, j), uv(i + 1, j + 1)], dst: [xy(i, j), xy(i + 1, j), xy(i + 1, j + 1)] })
      out.push({ src: [uv(i, j), uv(i + 1, j + 1), uv(i, j + 1)], dst: [xy(i, j), xy(i + 1, j + 1), xy(i, j + 1)] })
    }
  }
  return out
}

/**
 * The affine map taking triangle `src` onto triangle `dst`, as the six arguments of
 * CanvasRenderingContext2D.setTransform(a, b, c, d, e, f): x = a·u + c·v + e,
 * y = b·u + d·v + f. Null for a degenerate source triangle.
 */
export function triangleTransform(src, dst) {
  const [[u0, v0], [u1, v1], [u2, v2]] = src
  const [[x0, y0], [x1, y1], [x2, y2]] = dst
  const su1 = u1 - u0,
    sv1 = v1 - v0,
    su2 = u2 - u0,
    sv2 = v2 - v0
  const det = su1 * sv2 - su2 * sv1
  if (!det) return null
  const dx1 = x1 - x0,
    dy1 = y1 - y0,
    dx2 = x2 - x0,
    dy2 = y2 - y0
  const a = (dx1 * sv2 - dx2 * sv1) / det,
    c = (dx2 * su1 - dx1 * su2) / det,
    b = (dy1 * sv2 - dy2 * sv1) / det,
    d = (dy2 * su1 - dy1 * su2) / det
  return [a, b, c, d, x0 - a * u0 - c * v0, y0 - b * u0 - d * v0]
}

/** The bounding box [minX, minY, maxX, maxY] of points. */
export function pointsExtent(points) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

export const IMAGE_LAYER_MODES = ['selected', 'all']

/**
 * What the Images layer draws: one item per image with a footprint, or only the
 * selected one (`mode` 'selected'). `footprints` is the computed footprint set's
 * polygons, `images` the image records. The selected image is drawn from its display
 * image when it is loaded, every other from its ≤256 px thumbnail (`thumb`), which may
 * still have to be requested (`url` null).
 * → [{ imageId, quad, url, full }]
 */
export function imageOverlayItems(footprints, images, { mode = 'selected', selectedId = null } = {}) {
  const byId = new Map(images.map((img) => [img.id, img]))
  const out = []
  for (const fp of footprints) {
    const ring = fp.rings?.[0]
    const img = fp.imageId ? byId.get(fp.imageId) : null
    if (!img || !ring || ring.length < 4) continue
    const selected = img.id === selectedId
    if (mode === 'selected' && !selected) continue
    const full = selected && !!img.url
    out.push({ imageId: img.id, quad: ring.slice(0, 4), url: full ? img.url : (img.thumb?.url ?? null), full })
  }
  return out
}

/** The Photos layer's id in the map's layer stack (core/products/mapOrder.js). */
export const IMAGE_LAYER_ID = 'images'

/**
 * The persisted Photos layer state, { visible, opacity, mode }, or null when it has
 * never been put on the map. Malformed values fall back to the defaults.
 */
export function normalizeImageLayer(raw) {
  if (!raw || typeof raw !== 'object') return null
  const opacity = Number(raw.opacity)
  return {
    visible: raw.visible === true,
    opacity: Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1,
    mode: IMAGE_LAYER_MODES.includes(raw.mode) ? raw.mode : 'selected',
  }
}
