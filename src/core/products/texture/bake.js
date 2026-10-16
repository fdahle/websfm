// Filling the atlas from the photos (plan-texture ▸ Pipeline 5–6). Pure.
//
// Views are visited in order and each photo is decoded once (the caller's loadPhoto, at
// the texel scale and never above native). Every texel of a piece's rectangle, padding
// included, samples the photo: a chart's UVs are its projection into that photo, so the
// texel → photo map is the grid scale plus the caller's lens/scan map and nothing else.
// The padding therefore holds the real neighbouring image, and mipmaps of the page never
// pull in background colour.

import { sampleRgbaBilinear } from '../undistort.js'
import { srgbToLinear, linearToSrgb } from '../colourGains.js'

// layout = { pageSize, pageHeights, scale, pieces: { count, view, x0, y0, w, h },
//            place: { page, x, y }, flat: { count, colour: Uint8Array(3·count), size } }
// Pieces 0..pieces.count−1 are photo pieces, the next flat.count are flat palette cells.
// hooks.loadPhoto(vi, scale) → { data, width, height, map } | null, where map takes a
// scaled-grid pixel (texel scale) to the decoded raster's pixel (null = identity).
// hooks.onPhoto(vi, photo) runs while the photo is loaded (colour-levelling samples).
// → { pages: Uint8ClampedArray[] (RGBA), decoded, failed: number[] (views) }
export async function bakeAtlas(layout, hooks = {}, fallback = [128, 128, 128]) {
  const { pageSize: P, pageHeights, pieces, place, flat } = layout
  const pages = pageHeights.map((h) => new Uint8ClampedArray(P * h * 4))
  // Pieces grouped by view.
  const byView = new Map()
  for (let p = 0; p < pieces.count; p++) {
    const vi = pieces.view[p]
    if (!byView.has(vi)) byView.set(vi, [])
    byView.get(vi).push(p)
  }
  const failed = []
  let decoded = 0, done = 0
  for (const [vi, list] of byView) {
    const photo = await hooks.loadPhoto(vi, layout.scale)
    if (!photo) {
      failed.push(vi)
      for (const p of list) fillRect(pages[place.page[p]], P, place.x[p], place.y[p], pieces.w[p], pieces.h[p], fallback)
    } else {
      decoded++
      const { data, width, height, map } = photo
      for (const p of list) {
        const page = pages[place.page[p]], ax = place.x[p], ay = place.y[p]
        const x0 = pieces.x0[p], y0 = pieces.y0[p], w = pieces.w[p], h = pieces.h[p]
        for (let j = 0; j < h; j++) {
          let o = ((ay + j) * P + ax) * 4
          for (let i = 0; i < w; i++, o += 4) {
            if (map) {
              const m = map(x0 + i, y0 + j)
              sampleRgbaBilinear(data, width, height, m.x, m.y, page, o)
            } else sampleRgbaBilinear(data, width, height, x0 + i, y0 + j, page, o)
            page[o + 3] = 255
          }
        }
      }
      hooks.onPhoto?.(vi, photo)
    }
    hooks.onProgress?.(++done, byView.size)
  }
  for (let c = 0; c < flat.count; c++) {
    const p = pieces.count + c
    fillRect(pages[place.page[p]], P, place.x[p], place.y[p], flat.size, flat.size,
      [flat.colour[3 * c], flat.colour[3 * c + 1], flat.colour[3 * c + 2]])
  }
  return { pages, decoded, failed }
}

function fillRect(page, P, x, y, w, h, [r, g, b]) {
  for (let j = 0; j < h; j++) {
    let o = ((y + j) * P + x) * 4
    for (let i = 0; i < w; i++, o += 4) { page[o] = r; page[o + 1] = g; page[o + 2] = b; page[o + 3] = 255 }
  }
}

// Multiply every photo piece by its view's gains, in linear light: one 256-entry table
// per view and channel, so the pass costs a lookup per byte.
export function applyGains(pages, layout, gains) {
  const { pageSize: P, pieces, place } = layout
  const luts = new Map()
  const lutFor = (vi) => {
    let l = luts.get(vi)
    if (l) return l
    l = new Uint8Array(768)
    for (let c = 0; c < 3; c++) {
      const g = gains[3 * vi + c]
      for (let v = 0; v < 256; v++) l[256 * c + v] = linearToSrgb(g * srgbToLinear(v))
    }
    luts.set(vi, l)
    return l
  }
  for (let p = 0; p < pieces.count; p++) {
    const vi = pieces.view[p]
    if (gains[3 * vi] === 1 && gains[3 * vi + 1] === 1 && gains[3 * vi + 2] === 1) continue
    const l = lutFor(vi), page = pages[place.page[p]]
    const ax = place.x[p], ay = place.y[p], w = pieces.w[p], h = pieces.h[p]
    for (let j = 0; j < h; j++) {
      let o = ((ay + j) * P + ax) * 4
      for (let i = 0; i < w; i++, o += 4) {
        page[o] = l[page[o]]; page[o + 1] = l[256 + page[o + 1]]; page[o + 2] = l[512 + page[o + 2]]
      }
    }
  }
}
