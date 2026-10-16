// Rectangle packing into atlas pages (plan-texture ▸ Pipeline 4). Pure.
//
// First-fit decreasing height on shelves: rectangles sorted tallest first, each placed on
// the first shelf (on any page) with room left, else on a new shelf, else on a new page.
// Because heights only decrease, every open shelf is tall enough for the next rectangle,
// so the search is over remaining width alone. Typical fill on chart rectangles is
// 75–90 %; the price of FFDH's simplicity is the gap above short pieces on a tall shelf.

// w, h: Int32Array sizes (each ≤ pageSize). → { page, x, y: Int32Array, nPages,
// pageHeights: number[] } — the last page is cut to its used height (rounded up to 4).
export function packShelves(w, h, pageSize) {
  const n = w.length
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => h[b] - h[a] || w[b] - w[a])
  let minW = Infinity
  for (let i = 0; i < n; i++) if (w[i] < minW) minW = w[i]
  const page = new Int32Array(n), x = new Int32Array(n), y = new Int32Array(n)
  // Open shelves: page, top, used width. A shelf leaves the list once no rectangle can fit.
  const shelves = []
  const pageTop = [] // next free row per page
  for (const i of order) {
    const wi = w[i], hi = h[i]
    let s = -1
    for (let k = 0; k < shelves.length; k++) if (pageSize - shelves[k].used >= wi) { s = k; break }
    if (s < 0) {
      // A new shelf on the first page with rows left (shorter pieces fill earlier pages).
      let p = 0
      while (p < pageTop.length && pageTop[p] + hi > pageSize) p++
      if (p === pageTop.length) pageTop.push(0)
      shelves.push({ page: p, top: pageTop[p], used: 0 })
      pageTop[p] += hi
      s = shelves.length - 1
    }
    const sh = shelves[s]
    page[i] = sh.page; x[i] = sh.used; y[i] = sh.top
    sh.used += wi
    if (pageSize - sh.used < minW) shelves.splice(s, 1)
  }
  const nPages = pageTop.length
  const pageHeights = pageTop.map((top, p) => (p < nPages - 1 ? pageSize : Math.min(pageSize, Math.ceil(top / 4) * 4)))
  return { page, x, y, nPages, pageHeights }
}
