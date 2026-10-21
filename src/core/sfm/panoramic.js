// Panoramic (optical-bar) strips as frame-camera segments (plan-satellite ▸ group 2, the
// stopgap): KH-9 PC, KH-4 Corona and alike sweep a lens across track and expose a film
// held on a cylinder of radius f round the lens's axis, so a frame is a strip 15–20
// times longer than it is high, and no pinhole camera describes it. Cut into segments of
// a few degrees of scan each, though, every segment is resampled EXACTLY into a pinhole
// image: the camera turned to the segment's centre angle and seeing what the cylinder
// saw. Reconstruction then treats each segment as a frame camera with a pose of its own.
//
// What the stopgap leaves out: the satellite moves while the lens sweeps (a strip is one
// exposure position only for a stationary camera). Each segment's own pose takes its
// mid-scan position; the motion within a segment is not modelled.
//
// Coordinates. A strip pixel (u, v) is pixel-edge: pixel (i, j) spans [i, i+1) × [j, j+1).
// The scan runs along the strip's long side ('x' when wider than high): film arc length
// s = (u − u0)·p along the scan, t = (v − v0)·p across it (both mm, t down), u0 / v0 the
// scan centre (θ = 0) and the cylinder's mid-height, by default the strip's centre. The
// scan angle is θ = s / f and the ray (camera x along the scan, y down, z forward at
// θ = 0) is (sin θ, t / f, cos θ). Segment k looks along θk: its axes are
// xk = (cos θk, 0, −sin θk), y, zk = (sin θk, 0, cos θk), and its pixel (a, b) at the same
// pitch p sees the ray ((a − w/2)·p)·xk + ((b − h/2)·p)·y + f·zk.

// The segments a strip is cut into. strip: { width, height, pitchMm, focalMm, axis?: 'x' |
// 'y', u0?, v0? }; segments: how many (0 / null = near-square, one per strip height of
// scan); overlap: the fraction of a segment's core width added on each side, so
// neighbouring segments share points. → { axis, scanRad, length, across, u0, v0,
// segments: [{ index, thetaRad, halfRad, coreHalfRad, width, height, cx, cy }] } — cx / cy
// in the sensor table's pixel-centre convention (the segment's centre).
export function panoramicSegments(strip, { segments = 0, overlap = 0.1 } = {}) {
  const { width, height, pitchMm: p, focalMm: f } = strip
  if (!(width > 0 && height > 0 && p > 0 && f > 0))
    throw new Error('a panoramic strip needs its size, scan pixel size and focal length')
  const axis = strip.axis ?? (width >= height ? 'x' : 'y')
  const length = axis === 'x' ? width : height,
    across = axis === 'x' ? height : width
  const u0 = strip.u0 ?? width / 2,
    v0 = strip.v0 ?? height / 2
  const c0 = axis === 'x' ? u0 : v0
  // The scan the strip shows, either side of its centre.
  const lo = (-c0 * p) / f,
    hi = ((length - c0) * p) / f
  const scanRad = hi - lo
  const n = Math.max(1, Math.round(segments > 0 ? segments : length / across))
  const core = scanRad / n
  const half = Math.min((core / 2) * (1 + 2 * Math.max(0, overlap)), Math.PI / 3)
  // Wide enough for the segment's angle, high enough for the strip's full height at its
  // edges (the cylinder's height maps to b = t / cos θ there).
  const w = Math.max(1, Math.ceil((2 * f * Math.tan(half)) / p))
  const h = Math.max(1, Math.ceil(across / Math.cos(half)))
  const out = []
  for (let k = 0; k < n; k++) {
    const thetaRad = lo + (k + 0.5) * core
    out.push({
      index: k,
      thetaRad,
      halfRad: half,
      coreHalfRad: core / 2,
      width: w,
      height: h,
      cx: w / 2 - 0.5,
      cy: h / 2 - 0.5,
    })
  }
  return { axis, scanRad, length, across, u0, v0, segments: out }
}

// A segment pixel (pixel-edge a, b) → the strip pixel (pixel-edge u, v) it samples.
export function segmentToStrip(seg, layout, strip, a, b) {
  const p = strip.pitchMm,
    f = strip.focalMm
  const am = (a - seg.width / 2) * p,
    bm = (b - seg.height / 2) * p
  const c = Math.cos(seg.thetaRad),
    s = Math.sin(seg.thetaRad)
  // r = am·xk + bm·y + f·zk
  const rx = am * c + f * s,
    ry = bm,
    rz = -am * s + f * c
  const theta = Math.atan2(rx, rz)
  const t = (f * ry) / Math.hypot(rx, rz)
  const along = (layout.axis === 'x' ? layout.u0 : layout.v0) + (f * theta) / p
  const acr = (layout.axis === 'x' ? layout.v0 : layout.u0) + t / p
  return layout.axis === 'x' ? { u: along, v: acr } : { u: acr, v: along }
}

// A strip pixel (pixel-edge u, v) → the segment pixel (pixel-edge a, b) that shows it, or
// null when the segment cannot (behind it, past 80° off its axis).
export function stripToSegment(seg, layout, strip, u, v) {
  const p = strip.pitchMm,
    f = strip.focalMm
  const along = layout.axis === 'x' ? u - layout.u0 : v - layout.v0
  const acr = layout.axis === 'x' ? v - layout.v0 : u - layout.u0
  const theta = (along * p) / f,
    t = acr * p
  const dx = Math.sin(theta),
    dy = t / f,
    dz = Math.cos(theta)
  const c = Math.cos(seg.thetaRad),
    s = Math.sin(seg.thetaRad)
  const kx = dx * c - dz * s,
    kz = dx * s + dz * c
  if (!(kz > Math.cos((80 * Math.PI) / 180) * Math.hypot(kx, dy, kz))) return null
  return { a: seg.width / 2 + (f * kx) / kz / p, b: seg.height / 2 + (f * dy) / kz / p }
}

// The segment images' names: `<strip>_s01.tif` …, in scan order.
export function segmentName(stripName, k) {
  const stem = String(stripName).replace(/\.[^.]+$/, '')
  return `${stem}_s${String(k + 1).padStart(2, '0')}.tif`
}
