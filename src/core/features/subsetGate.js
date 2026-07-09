// Subset gate: a cheap coarse pre-test that rejects non-overlapping image pairs
// before paying for full O(Na·Nb) descriptor matching. For each pair we match a
// small, spatially-uniform subset of each image's keypoints; if too few survive,
// the pair almost certainly doesn't overlap and the full match is skipped. This
// keeps exhaustive coverage (every pair is still *tested*, so loop closures are
// found anywhere in the graph) at ~(s/N)² of the cost per non-overlapping pair —
// the case with no imported poses, where proximity preselection can't help.
//
// Pure: keypoints + flat descriptor buffer in, indices / sliced buffer out.

// Pick up to `count` keypoint indices spread spatially across the image, so the
// subset actually samples the whole frame instead of clustering on the few
// high-contrast blobs a response-ranked top-N would collapse onto (the worst
// case for a repetitive façade). Grid-bucket the bounding box into ~count cells,
// aspect-matched, and keep the first keypoint seen per cell — keypoints arrive
// response-ordered from detection, so "first" ≈ strongest in that cell.
export function pickSpreadIndices(kps, count) {
  const n = kps.length
  if (n <= count) return Array.from({ length: n }, (_, i) => i)

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const { x, y } = kps[i]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const w = Math.max(1e-6, maxX - minX)
  const h = Math.max(1e-6, maxY - minY)
  // cols·rows ≈ count, with cols/rows ≈ w/h so cells stay roughly square
  const cols = Math.max(1, Math.round(Math.sqrt((count * w) / h)))
  const rows = Math.max(1, Math.ceil(count / cols))

  const chosen = new Map()
  for (let i = 0; i < n; i++) {
    const cx = Math.min(cols - 1, Math.floor(((kps[i].x - minX) / w) * cols))
    const cy = Math.min(rows - 1, Math.floor(((kps[i].y - minY) / h) * rows))
    const cell = cy * cols + cx
    if (!chosen.has(cell)) chosen.set(cell, i)
  }
  return Array.from(chosen.values())
}

// Gather the rows at `indices` from a flat row-major N×dim descriptor buffer into
// a compact indices.length×dim buffer, ready to hand to the brute-force matcher.
export function sliceDescriptorRows(desc, indices, dim) {
  const out = new Float32Array(indices.length * dim)
  for (let i = 0; i < indices.length; i++) {
    const off = indices[i] * dim
    out.set(desc.subarray(off, off + dim), i * dim)
  }
  return out
}
