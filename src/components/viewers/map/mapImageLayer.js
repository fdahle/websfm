// The Photos layer of the 2D map (View ▸ Map ▸ Photos): source images drawn into
// their footprints, warped by the homography of core/products/imageOverlay.js. One
// OpenLayers canvas layer for all of them: on each render it draws the photos in view
// straight onto a canvas of the view's size, triangle by triangle, so nothing is
// warped ahead of time and only what is on screen costs anything.
//
// Pixels come from the image's ≤256 px thumbnail, or the selected image's display
// image (cut to FULL_SIZE first); each is decoded once, when first in view, and
// released when the photo leaves the layer.

import ImageLayer from 'ol/layer/Image'
import ImageCanvasSource from 'ol/source/ImageCanvas'
import { intersects } from 'ol/extent'
import { pointsExtent, triangleTransform, warpMesh } from '../../../core/products/imageOverlay.js'

// Longest side the selected image is drawn from: sharp at any useful zoom, and 128
// draws of it stay fast.
const FULL_SIZE = 1024
// Mesh cells a side: the display image is seen up close, a thumbnail in a block.
const MESH_FULL = 8
const MESH_THUMB = 4
// Each triangle's clip is grown by this many pixels, so neighbours overlap and no
// antialiased seam shows between them.
const SEAM_PX = 0.75

/**
 * `request(imageId)`: asks for a thumbnail not made yet (the item's `url` is null).
 * → { layer, setItems(items), extent(), dispose() }
 */
export function createImageOverlay({ opacity = 1, request = () => {} } = {}) {
  let items = []
  const meshes = new Map() // imageId → { key, full, mesh, extent }
  const bitmaps = new Map() // url → HTMLImageElement | ImageBitmap | null (loading) | 'failed'
  const requested = new Set()
  let disposed = false

  const source = new ImageCanvasSource({ canvasFunction: draw, ratio: 1 })
  const layer = new ImageLayer({ source, opacity })

  function meshOf(item) {
    const key = item.quad.flat().join(',')
    let m = meshes.get(item.imageId)
    if (!m || m.key !== key || m.full !== item.full) {
      m = { key, full: item.full, mesh: warpMesh(item.quad, item.full ? MESH_FULL : MESH_THUMB) }
      m.extent = pointsExtent(m.mesh.flatMap((t) => t.dst))
      meshes.set(item.imageId, m)
    }
    return m
  }

  function release(bmp) {
    if (bmp && typeof bmp.close === 'function') bmp.close()
  }

  function load(url, full) {
    bitmaps.set(url, null)
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    img
      .decode()
      .then(async () => {
        let bmp = img
        const long = Math.max(img.naturalWidth, img.naturalHeight)
        if (full && long > FULL_SIZE && typeof createImageBitmap === 'function') {
          const k = FULL_SIZE / long
          bmp = await createImageBitmap(img, {
            resizeWidth: Math.round(img.naturalWidth * k),
            resizeHeight: Math.round(img.naturalHeight * k),
            resizeQuality: 'medium',
          })
        }
        // Dropped meanwhile (the photo left the layer, or the map was torn down).
        if (disposed || !bitmaps.has(url)) return release(bmp)
        bitmaps.set(url, bmp)
        source.changed()
      })
      .catch(() => {
        if (bitmaps.has(url)) bitmaps.set(url, 'failed')
      })
  }

  function drawTriangle(g, bmp, w, h, t, toPx) {
    const dst = t.dst.map(toPx)
    const m = triangleTransform(
      t.src.map(([u, v]) => [u * w, v * h]),
      dst,
    )
    if (!m) return
    const cx = (dst[0][0] + dst[1][0] + dst[2][0]) / 3,
      cy = (dst[0][1] + dst[1][1] + dst[2][1]) / 3
    g.save()
    g.beginPath()
    dst.forEach(([x, y], k) => {
      const dx = x - cx,
        dy = y - cy,
        len = Math.hypot(dx, dy) || 1,
        s = (len + SEAM_PX) / len
      if (k) g.lineTo(cx + dx * s, cy + dy * s)
      else g.moveTo(cx + dx * s, cy + dy * s)
    })
    g.closePath()
    g.clip()
    g.setTransform(...m)
    g.drawImage(bmp, 0, 0)
    g.restore()
  }

  // ImageCanvasSource's canvasFunction: the photos in `extent` on a canvas of `size`.
  function draw(extent, resolution, pixelRatio, size) {
    const canvas = document.createElement('canvas')
    canvas.width = size[0]
    canvas.height = size[1]
    const g = canvas.getContext('2d')
    g.imageSmoothingQuality = 'medium'
    const kx = size[0] / (extent[2] - extent[0]),
      ky = size[1] / (extent[3] - extent[1])
    const toPx = ([x, y]) => [(x - extent[0]) * kx, (extent[3] - y) * ky]
    for (const item of items) {
      const m = meshOf(item)
      if (!intersects(m.extent, extent)) continue
      if (!item.url) {
        if (!requested.has(item.imageId)) {
          requested.add(item.imageId)
          request(item.imageId)
        }
        continue
      }
      const bmp = bitmaps.get(item.url)
      if (bmp === undefined) load(item.url, item.full)
      if (!bmp || bmp === 'failed') continue
      const w = bmp.naturalWidth ?? bmp.width,
        h = bmp.naturalHeight ?? bmp.height
      for (const t of m.mesh) drawTriangle(g, bmp, w, h, t, toPx)
    }
    return canvas
  }

  // The selected image (drawn from its display image) goes last, so it is on top.
  function setItems(next) {
    items = [...next].sort((a, b) => Number(a.full) - Number(b.full))
    const urls = new Set(items.map((i) => i.url))
    for (const [url, bmp] of bitmaps) {
      if (urls.has(url)) continue
      release(bmp)
      bitmaps.delete(url)
    }
    const ids = new Set(items.map((i) => i.imageId))
    for (const id of meshes.keys()) if (!ids.has(id)) meshes.delete(id)
    for (const id of requested) if (!ids.has(id)) requested.delete(id)
    source.changed()
  }

  // The photos' combined extent in map coordinates, or null.
  function extent() {
    if (!items.length) return null
    return pointsExtent(
      items.flatMap((i) => {
        const [minX, minY, maxX, maxY] = meshOf(i).extent
        return [
          [minX, minY],
          [maxX, maxY],
        ]
      }),
    )
  }

  function dispose() {
    disposed = true
    for (const bmp of bitmaps.values()) release(bmp)
    bitmaps.clear()
    meshes.clear()
    items = []
  }

  layer.set('imageOverlay', true)
  return { layer, setItems, extent, dispose }
}
