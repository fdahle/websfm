// From the text lines found on photographs to the regions Auto Mask ▸ Text excludes.
// Pure: lines in, polygons in native pixels out; the canvas drawing is
// utils/maskCanvas.js.
//
// Which lines are masked:
// - Sure text, masked where it was found: read with at least SURE_TEXT_SCORE and at
//   least SURE_TEXT_CHARS letters or digits. The detector also boxes buildings, field
//   edges and crevasses; they read as nonsense with less confidence, or as one or two
//   characters (a T-shaped roof as "T" at 0.95).
// - Recurring text: a line read with at least MIN_TEXT_SCORE that a camera prints at the
//   same place on enough of its frames (the data strip, the frame counter, the dials of
//   a data card) is masked on every frame of that camera, including frames where it
//   was not found (cloud, glare, a smudged print): boxes found on enough frames, in
//   coordinates the frames share, are drawn on all of them (as hist_sfm's
//   text_regions does). The scene moves between frames, so what is not text does not
//   recur.

import { growPolygon, polyBounds } from './quad.js'

// A line read with less confidence than this is no text (terrain, film grain).
export const MIN_TEXT_SCORE = 0.5
export const SURE_TEXT_SCORE = 0.9
export const SURE_TEXT_CHARS = 3

const alnumCount = (text) => [...(text ?? '')].filter((c) => /[\p{L}\p{N}]/u.test(c)).length

/** Whether a line may be text: read, with at least MIN_TEXT_SCORE and a letter or digit. */
export function isTextCandidate(line) {
  return line.textScore >= MIN_TEXT_SCORE && alnumCount(line.text) > 0
}

/** Whether a line is text for sure, masked on its own frame alone. */
export function isSureText(line) {
  return line.textScore >= SURE_TEXT_SCORE && alnumCount(line.text) >= SURE_TEXT_CHARS
}

/** A line's box (native pixels) grown by `padPx` on every side. */
export function linePolygon(line, padPx) {
  return growPolygon(line.quad, padPx)
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

// Text on fewer frames than this is not taken as recurring: with two, two buildings
// boxed at the same place on two frames would be.
export const MIN_RECURRING_FRAMES = 3

// Boxes of one cluster are the same print: within a factor of 4 in area.
function similarSize(a, b) {
  const area = (r) => Math.max(1e-12, (r[2] - r[0]) * (r[3] - r[1]))
  const k = area(a) / area(b)
  return k <= 4 && k >= 0.25
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
 * max(MIN_RECURRING_FRAMES, ⌈minShare · frames⌉) frames is returned, in the same
 * coordinates.
 */
export function recurringBoxes(frames, minShare = 0.2) {
  const clusters = []
  for (const { id, boxes } of frames)
    for (const box of boxes) {
      const hit = clusters.find((c) => overlapSmaller(c.box, box) >= 0.5 && similarSize(c.box, box))
      if (hit) {
        hit.members.push({ id, box })
        hit.box = typicalBox(hit.members)
      } else clusters.push({ box, members: [{ id, box }] })
    }
  const needed = Math.max(MIN_RECURRING_FRAMES, Math.ceil(minShare * frames.length))
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
