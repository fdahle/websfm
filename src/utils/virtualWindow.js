// Pure window math for virtualised lists (composables/useVirtualList.js). A list
// of N rows renders only the slice that intersects the viewport plus an overscan
// margin; two spacers (padTop/padBottom) stand in for the rest so the scrollbar
// keeps its full length. No DOM here: every position is in LIST space, i.e. pixels
// from the top of the list's first row, and the caller converts the scroller's
// scrollTop into that space (`scrollTop - listOffset`).
//
// Rows are either a fixed height (`itemHeight`, a number) or carry their own
// heights, given as prefix offsets (`offsets[i]` = top of row i, `offsets[n]` =
// total height) — the sidebar's expanded image details and group headers differ.

// Prefix offsets of a height list: length n + 1, offsets[0] = 0.
export function prefixOffsets(heights) {
  const n = heights.length
  const out = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) out[i + 1] = out[i] + Math.max(0, heights[i] || 0)
  return out
}

// Index of the row containing list-space y (binary search over the offsets);
// clamped into [0, n − 1]. n = 0 ⇒ 0.
export function indexAtOffset(offsets, y) {
  const n = offsets.length - 1
  if (n <= 0) return 0
  if (y <= 0) return 0
  if (y >= offsets[n]) return n - 1
  let lo = 0,
    hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

// The rows to render. `start` inclusive, `end` exclusive; `padTop`/`padBottom` are
// the spacer heights so padTop + Σ rendered heights + padBottom = total.
//   { count, itemHeight?, offsets?, scrollTop, viewportHeight, overscan = 6 }
// A non-positive viewport (not laid out yet, a hidden tab) still yields a first
// screenful, so the initial paint is never empty and a measurement can be taken.
export function computeWindow({
  count,
  itemHeight,
  offsets,
  scrollTop = 0,
  viewportHeight = 0,
  overscan = 6,
  minRows = 30,
}) {
  const n = Math.max(0, count | 0)
  if (!n) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 }
  const fixed = !offsets
  const h = fixed ? Math.max(1, itemHeight || 1) : 0
  const total = fixed ? n * h : offsets[n]
  const top = Math.max(0, scrollTop)
  const height = viewportHeight > 0 ? viewportHeight : 0
  let first, last
  if (fixed) {
    first = Math.floor(top / h)
    last = height > 0 ? Math.ceil((top + height) / h) : first + minRows
  } else {
    first = indexAtOffset(offsets, top)
    last = height > 0 ? indexAtOffset(offsets, top + height) + 1 : first + minRows
  }
  const start = Math.max(0, Math.min(n - 1, first) - overscan)
  const end = Math.min(n, Math.max(last, start + 1) + overscan)
  const startY = fixed ? start * h : offsets[start]
  const endY = fixed ? end * h : offsets[end]
  return { start, end, padTop: startY, padBottom: Math.max(0, total - endY), total }
}

// Smallest scroll (in list space) that brings row `index` fully into view, or null
// when it already is. A row taller than the viewport aligns its top.
export function scrollToReveal({ index, count, itemHeight, offsets, scrollTop = 0, viewportHeight = 0 }) {
  if (index == null || index < 0 || index >= count) return null
  const top = offsets ? offsets[index] : index * itemHeight
  const bottom = offsets ? offsets[index + 1] : top + itemHeight
  if (top < scrollTop) return top
  if (viewportHeight > 0 && bottom > scrollTop + viewportHeight) {
    return bottom - top > viewportHeight ? top : bottom - viewportHeight
  }
  return null
}
