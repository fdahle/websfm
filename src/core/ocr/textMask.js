// From the text lines found on photographs to the regions Auto Mask ▸ Text excludes.
// Pure: lines in, polygons in native pixels out; the canvas drawing is
// utils/maskCanvas.js.
//
// Two rules beyond "mask every line":
// - A line only counts when it reads as text (its recognition score): the detector
//   also boxes crevasses, roads and field edges, which read as one or two unsure
//   characters.
// - Text a camera prints at the same place on every frame (the data strip, the frame
//   counter) is masked on every frame of that camera, including frames where it was
//   not found (cloud, glare, a smudged print): boxes found on enough frames, in
//   coordinates the frames share, are drawn on all of them (as hist_sfm's
//   text_regions does).

import { growPolygon, polyBounds } from './quad.js'

// A line reading with less confidence than this is no text (terrain, film grain).
export const MIN_TEXT_SCORE = 0.5
// A box read as only one or two characters needs this much confidence.
export const MIN_SHORT_TEXT_SCORE = 0.8

/** Whether a found line is text to mask (it was read, and reads as text). */
export function isTextLine(line, minScore = MIN_TEXT_SCORE) {
  if (line.textScore == null) return line.score != null
  const chars = [...(line.text ?? '')].filter((c) => /[\p{L}\p{N}]/u.test(c)).length
  if (chars === 0) return false
  return line.textScore >= (chars <= 2 ? Math.max(minScore, MIN_SHORT_TEXT_SCORE) : minScore)
}

/**
 * A line's box in native pixels, grown by `padPx` on every side. `scale` is the
 * detection raster's size over the native one.
 */
export function linePolygon(line, scale, padPx) {
  const native = line.quad.map(([x, y]) => [x / scale, y / scale])
  return growPolygon(native, padPx)
}

// Intersection over the smaller box: a short read inside a long one still matches.
function overlapSmaller(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  if (w <= 0 || h <= 0) return 0
  const smaller = Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
  return smaller > 0 ? (w * h) / smaller : 0
}

function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos),
    hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

// The box most of a cluster's members agree on: the outer quartiles of their edges,
// not their union, so one frame aligned badly cannot grow it over the photograph.
function typicalBox(members) {
  return [
    quantile(
      members.map((m) => m.box[0]),
      0.25,
    ),
    quantile(
      members.map((m) => m.box[1]),
      0.25,
    ),
    quantile(
      members.map((m) => m.box[2]),
      0.75,
    ),
    quantile(
      members.map((m) => m.box[3]),
      0.75,
    ),
  ]
}

/**
 * Boxes where text recurs on the frames of one camera. `frames` is
 * `[{ id, boxes: [[x0, y0, x1, y1]] }]` in coordinates every frame shares (film mm
 * through the fiducials, or the fraction of the photo). A box seen on at least
 * max(2, ⌈minShare · frames⌉) frames is returned, in the same coordinates.
 */
export function recurringBoxes(frames, minShare = 0.2) {
  const clusters = []
  for (const { id, boxes } of frames)
    for (const box of boxes) {
      const hit = clusters.find((c) => overlapSmaller(c.box, box) >= 0.5)
      if (hit) {
        hit.members.push({ id, box })
        hit.box = typicalBox(hit.members)
      } else clusters.push({ box, members: [{ id, box }] })
    }
  const needed = Math.max(2, Math.ceil(minShare * frames.length))
  return clusters.filter((c) => new Set(c.members.map((m) => m.id)).size >= needed).map((c) => typicalBox(c.members))
}

/** The axis-aligned box of a polygon mapped through `f` ([x, y] → [x, y]). */
export function mappedBox(poly, f) {
  return polyBounds(poly.map(f))
}

/** A shared-coordinates box as a polygon on one frame, through `f` (shared → native). */
export function boxPolygon([x0, y0, x1, y1], f) {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(f)
}

/** Share of a w×h photo the polygons' bounding boxes cover (an upper bound, for the log and the guard). */
export function coveredShare(polys, w, h) {
  let a = 0
  for (const p of polys) {
    const [x0, y0, x1, y1] = polyBounds(p)
    a += Math.max(0, Math.min(w, x1) - Math.max(0, x0)) * Math.max(0, Math.min(h, y1) - Math.max(0, y0))
  }
  return Math.min(1, a / (w * h))
}
