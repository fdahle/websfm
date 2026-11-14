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
  const { pageSize: P, pageHeights } = layout
  const pages = pageHeights.map((h) => new Uint8ClampedArray(P * h * 4))
  const { decoded, failed } = await bakeViews(layout, bakeOrder(layout), pageTarget(layout, pages), hooks, fallback)
  fillFlat(layout, pages)
  return { pages, decoded, failed }
}

// The photo pieces grouped by view, in the order the bake visits the photos (each view
// at its first piece): [[vi, [piece, …]], …]. A run may split this list into shares.
export function bakeOrder(layout) {
  const { pieces } = layout
  const byView = new Map()
  for (let p = 0; p < pieces.count; p++) {
    const vi = pieces.view[p]
    if (!byView.has(vi)) byView.set(vi, [])
    byView.get(vi).push(p)
  }
  return [...byView]
}

// Where piece p's texels go: its rectangle on its page (`stride` bytes a row).
export function pageTarget(layout, pages) {
  const { pageSize: P, place } = layout
  return (p) => ({ buf: pages[place.page[p]], off: (place.y[p] * P + place.x[p]) * 4, stride: P * 4 })
}

// A share's own buffer: its pieces' rectangles one after another, each `w` texels a row.
// → { data, offset: Map(piece → byte offset), target }
export function pieceBlocks(layout, entries) {
  const { pieces } = layout
  const offset = new Map()
  let bytes = 0
  for (const [, list] of entries)
    for (const p of list) {
      offset.set(p, bytes)
      bytes += pieces.w[p] * pieces.h[p] * 4
    }
  const data = new Uint8ClampedArray(bytes)
  return { data, offset, target: (p) => ({ buf: data, off: offset.get(p), stride: pieces.w[p] * 4 }) }
}

// Copy a share's blocks (pieceBlocks, with the pieces in `list` order) onto the pages.
export function pasteBlocks(layout, pages, list, data) {
  const { pageSize: P, pieces, place } = layout
  let off = 0
  for (const p of list) {
    const w = pieces.w[p],
      h = pieces.h[p],
      page = pages[place.page[p]]
    for (let j = 0; j < h; j++, off += 4 * w)
      page.set(data.subarray(off, off + 4 * w), ((place.y[p] + j) * P + place.x[p]) * 4)
  }
}

// Bake the views of `entries` (bakeOrder's form) into `target(p)`: each photo decoded
// once, every texel of its pieces sampled. A photo that cannot be read leaves its
// pieces `fallback` grey. → { decoded, failed: number[] (views) }
export async function bakeViews(layout, entries, target, hooks = {}, fallback = [128, 128, 128]) {
  const { pieces } = layout
  const failed = []
  let decoded = 0,
    done = 0
  for (const [vi, list] of entries) {
    const photo = await hooks.loadPhoto(vi, layout.scale)
    if (!photo) {
      failed.push(vi)
      for (const p of list) {
        const t = target(p)
        fillRect(t.buf, t.off, t.stride, pieces.w[p], pieces.h[p], fallback)
      }
    } else {
      decoded++
      const { data, width, height, map } = photo
      for (const p of list) {
        const { buf, off, stride } = target(p)
        const x0 = pieces.x0[p],
          y0 = pieces.y0[p],
          w = pieces.w[p],
          h = pieces.h[p]
        for (let j = 0; j < h; j++) {
          let o = off + j * stride
          for (let i = 0; i < w; i++, o += 4) {
            if (map) {
              const m = map(x0 + i, y0 + j)
              sampleRgbaBilinear(data, width, height, m.x, m.y, buf, o)
            } else sampleRgbaBilinear(data, width, height, x0 + i, y0 + j, buf, o)
            buf[o + 3] = 255
          }
        }
      }
      hooks.onPhoto?.(vi, photo)
    }
    hooks.onProgress?.(++done, entries.length)
  }
  return { decoded, failed }
}

// The flat palette cells (unseen faces), after the photo pieces.
export function fillFlat(layout, pages) {
  const { pageSize: P, pieces, place, flat } = layout
  for (let c = 0; c < flat.count; c++) {
    const p = pieces.count + c
    fillRect(pages[place.page[p]], (place.y[p] * P + place.x[p]) * 4, P * 4, flat.size, flat.size, [
      flat.colour[3 * c],
      flat.colour[3 * c + 1],
      flat.colour[3 * c + 2],
    ])
  }
}

function fillRect(buf, off, stride, w, h, [r, g, b]) {
  for (let j = 0; j < h; j++) {
    let o = off + j * stride
    for (let i = 0; i < w; i++, o += 4) {
      buf[o] = r
      buf[o + 1] = g
      buf[o + 2] = b
      buf[o + 3] = 255
    }
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
    const l = lutFor(vi),
      page = pages[place.page[p]]
    const ax = place.x[p],
      ay = place.y[p],
      w = pieces.w[p],
      h = pieces.h[p]
    for (let j = 0; j < h; j++) {
      let o = ((ay + j) * P + ax) * 4
      for (let i = 0; i < w; i++, o += 4) {
        page[o] = l[page[o]]
        page[o + 1] = l[256 + page[o + 1]]
        page[o + 2] = l[512 + page[o + 2]]
      }
    }
  }
}
