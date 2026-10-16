// Rectangle packing into atlas pages (plan-texture ▸ Pipeline 4). Pure.
//
// Skyline, bottom-left: each page keeps its skyline, the top edge of what has been
// placed, as a list of horizontal segments. A rectangle goes where its top would be
// lowest (ties: leftmost) on the first page that has room, else on a new page.
// Rectangles go tallest first. Shelf packing (first-fit decreasing height) left the
// space under every tall shelf empty next to the shorter pieces that followed; on a
// building with a few large facade charts that was a third of the page.

// w, h: Int32Array sizes (each ≤ pageSize). → { page, x, y: Int32Array, nPages,
// pageHeights: number[] } — the last page is cut to its used height (rounded up to 4).
export function packAtlas(w, h, pageSize) {
  const n = w.length, P = pageSize
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => h[b] - h[a] || w[b] - w[a])
  const page = new Int32Array(n), x = new Int32Array(n), y = new Int32Array(n)
  // Per page: skyline segments as parallel arrays (x, top, width), sorted by x.
  const pages = []
  const newPage = () => { pages.push({ sx: [0], sy: [0], sw: [P], minTop: 0, used: 0 }); return pages.length - 1 }
  for (const i of order) {
    const wi = w[i], hi = h[i]
    let placed = false
    for (let p = 0; p < pages.length && !placed; p++) {
      const pg = pages[p]
      if (pg.minTop + hi > P) continue
      const fit = bestFit(pg, wi, hi, P)
      if (fit) { place(pg, fit, wi, hi); page[i] = p; x[i] = fit.x; y[i] = fit.y; placed = true }
    }
    if (!placed) {
      const p = newPage(), pg = pages[p]
      const fit = bestFit(pg, wi, hi, P)
      place(pg, fit, wi, hi); page[i] = p; x[i] = fit.x; y[i] = fit.y
    }
  }
  const nPages = pages.length
  const pageHeights = pages.map((pg, p) => (p < nPages - 1 ? P : Math.min(P, Math.ceil(pg.used / 4) * 4)))
  return { page, x, y, nPages, pageHeights }
}

// Lowest-top position for a w×h rectangle starting at a segment's left edge.
function bestFit(pg, w, h, P) {
  const { sx, sy, sw } = pg
  let best = null
  for (let s = 0; s < sx.length; s++) {
    const x0 = sx[s]
    if (x0 + w > P) break
    // The rectangle rests on the highest segment it spans.
    let top = 0, reach = 0, k = s
    while (reach < w) { top = Math.max(top, sy[k]); reach += sw[k]; k++ }
    if (top + h > P) continue
    if (!best || top + h < best.y + h || (top + h === best.y + h && x0 < best.x)) best = { x: x0, y: top, s }
  }
  return best
}

// Raise the skyline under a placed rectangle and merge equal neighbours.
function place(pg, { x: x0, y, s }, w, h) {
  const { sx, sy, sw } = pg
  const top = y + h, x1 = x0 + w
  // Segments [s, e) are covered; the last one may stick out on the right.
  let e = s
  while (e < sx.length && sx[e] < x1) e++
  const last = e - 1
  const tailX = x1, tailW = sx[last] + sw[last] - x1, tailY = sy[last]
  const ins = { x: [x0], y: [top], w: [w] }
  if (tailW > 0) { ins.x.push(tailX); ins.y.push(tailY); ins.w.push(tailW) }
  sx.splice(s, e - s, ...ins.x); sy.splice(s, e - s, ...ins.y); sw.splice(s, e - s, ...ins.w)
  for (let k = Math.max(0, s - 1); k < sx.length - 1 && k <= s + 1;) {
    if (sy[k] === sy[k + 1]) { sw[k] += sw[k + 1]; sx.splice(k + 1, 1); sy.splice(k + 1, 1); sw.splice(k + 1, 1) } else k++
  }
  let minTop = Infinity
  for (let k = 0; k < sy.length; k++) if (sy[k] < minTop) minTop = sy[k]
  pg.minTop = minTop
  if (top > pg.used) pg.used = top
}
