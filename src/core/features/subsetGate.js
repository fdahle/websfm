// Subset gate: a cheap coarse pre-test that rejects non-overlapping image pairs
// before paying for full O(Na·Nb) descriptor matching. For each pair we match a
// small, spatially-uniform subset of each image's keypoints; if too few survive,
// the pair almost certainly doesn't overlap and the full match is skipped. This
// keeps exhaustive coverage (every pair is still *tested*, so loop closures are
// found anywhere in the graph) at ~(s/N)² of the cost per non-overlapping pair —
// the case with no imported poses, where proximity preselection can't help.
//
// Pure: keypoints + flat descriptor buffer in, indices / sliced buffer out.
//
// ── Why the subset SIZE has to scale with the keypoint count ───────────────────
// The gate's decision is "did at least `subsetGateThreshold` putatives survive?",
// but the number it is judging is a *sample*. For a genuinely overlapping pair
// with M true matches at full density, matching an s-keypoint subset of each image
// yields, in expectation,
//
//     E[subset putatives] ≈ (s / Na) · (s / Nb) · M
//
// so with s held FIXED the statistic falls as ~1/N while the threshold stays put.
// At the shipped subset size of 200 and a threshold of 8:
//
//     Na = Nb =  1 000, M ≈   400  →  E ≈ 16    passes
//     Na = Nb =  5 000, M ≈ 2 000  →  E ≈  3.2  false veto
//     Na = Nb = 25 000, M ≈10 000  →  E ≈  0.6  vetoes essentially every pair
//
// The last row is the SIFT "Detailed" preset (maxKeypoints 25 000): choosing a
// higher-quality detection setting would have silently severed the match graph,
// with the damage appearing several stages later as a sparse reconstruction that
// registers a handful of cameras. Nothing in the logs would point back here.
//
// Scaling the size instead of the threshold is the fix that keeps the statistic
// well-conditioned: dropping the threshold to 1 to match a 0.6 expectation is not
// a gate, it is a coin flip. Holding s / √(Na·Nb) constant makes E depend only on
// the scene overlap — which is the thing the gate is actually trying to measure.
// See resolveSubsetGateSize below.

// Co-located defaults (the self-contained-pure-module exception in CLAUDE.md ▸
// Conventions; tuning.js points here rather than duplicating them).
export const SUBSET_GATE_SIZE_DEFAULTS = {
  // Sampling fraction of √(Na·Nb). Calibrated so the historical pairing — a 200
  // subset at ~5000 keypoints/image — is reproduced exactly (200 / 5000 = 0.04),
  // which is what keeps the shipped `subsetGateThreshold` meaningful.
  fraction: 0.04,
  // Below this the sample is too small to carry a threshold of ~8 regardless of
  // arithmetic. Overridden by the user's `subsetGateSize`, which acts as the floor.
  minSize: 200,
  // Cost ceiling: the gate is O(s²) per pair and only earns its place by being far
  // cheaper than the O(Na·Nb) match it replaces. 1000 covers the largest keypoint
  // cap we ship (SIFT Detailed, 25 000 → exactly 1000) while still being ~600×
  // cheaper than the full match it may skip.
  maxSize: 1000,
}

// Resolve the per-pair subset size from the two images' actual keypoint counts.
// `floorSize` is the user-facing `subsetGateSize` setting, reinterpreted as a
// minimum (it was previously the exact size; for any set at or below ~5000
// keypoints/image the floor still binds, so the historical behaviour is preserved
// where it was already correct).
//
// Uses the ACTUAL counts, not the configured `maxKeypoints` cap: an image may
// detect far fewer than its budget allows, and the sample has to be sized against
// what is really there.
//
// Returns { size, fraction, clamped } — `clamped` is 'floor' | 'ceil' | null so a
// caller can report why, since a silently resized sample is not auditable.
export function resolveSubsetGateSize(nA, nB, opts = {}) {
  const {
    fraction = SUBSET_GATE_SIZE_DEFAULTS.fraction,
    minSize = SUBSET_GATE_SIZE_DEFAULTS.minSize,
    maxSize = SUBSET_GATE_SIZE_DEFAULTS.maxSize,
    floorSize = null,
  } = opts

  const lo = Math.max(minSize, Number.isFinite(floorSize) && floorSize > 0 ? floorSize : 0)
  const a = Number.isFinite(nA) && nA > 0 ? nA : 0
  const b = Number.isFinite(nB) && nB > 0 ? nB : 0
  if (a === 0 || b === 0) return { size: lo, fraction: 0, clamped: 'floor' }

  const raw = Math.round(fraction * Math.sqrt(a * b))
  // The ceiling wins over the floor when they conflict: it is a hard cost bound,
  // whereas the floor is a statistical preference.
  const size = Math.min(maxSize, Math.max(lo, raw))
  const clamped = raw > maxSize ? 'ceil' : raw < lo ? 'floor' : null
  return { size, fraction: size / Math.sqrt(a * b), clamped }
}

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
