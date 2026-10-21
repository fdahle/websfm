// Carrying a texture through mesh edits (plan-texture T5). Pure.
//
// A textured mesh stores its faces sorted by atlas page, with `groups` giving each
// page's face range. The mesh tools (core/products/meshEdit.js) instead carry a page
// per face, since they drop and reorder triangles; these two convert between the forms.

import { UNTEXTURED } from '../meshEdit.js'

// groups [{ page, start, count }] → Uint16Array page per face (UNTEXTURED where none).
export function facePages(groups, faceCount) {
  const page = new Uint16Array(faceCount).fill(UNTEXTURED)
  for (const g of groups ?? []) page.fill(g.page, g.start, Math.min(faceCount, g.start + g.count))
  return page
}

// A mesh with `page` per face → { idx, groups } with the faces sorted by page (stable,
// so neighbouring faces stay together), or null when a face has no page (a filled
// hole): the texture then no longer covers the mesh.
export function regroupByPage(mesh) {
  const { idx, page } = mesh
  const F = idx.length / 3
  if (!page || page.length !== F) return null
  let pages = 0
  for (let f = 0; f < F; f++) {
    if (page[f] === UNTEXTURED) return null
    if (page[f] + 1 > pages) pages = page[f] + 1
  }
  const start = new Int32Array(pages + 1)
  for (let f = 0; f < F; f++) start[page[f] + 1]++
  for (let p = 0; p < pages; p++) start[p + 1] += start[p]
  const fill = start.slice(0, pages),
    out = new Uint32Array(idx.length)
  for (let f = 0; f < F; f++) {
    const o = 3 * fill[page[f]]++
    out[o] = idx[3 * f]
    out[o + 1] = idx[3 * f + 1]
    out[o + 2] = idx[3 * f + 2]
  }
  const groups = []
  for (let p = 0; p < pages; p++)
    if (start[p + 1] > start[p]) groups.push({ page: p, start: start[p], count: start[p + 1] - start[p] })
  return { idx: out, groups }
}
