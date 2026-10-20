import { describe, it, expect } from 'vitest'
import { panoramicSegments, segmentToStrip, stripToSegment, segmentName } from './panoramic.js'

// KH-9 PC at 56 µm: 1,524 mm over a 90° scan, 157 mm across.
const strip = { width: Math.round(1524 * Math.PI / 2 / 0.056), height: Math.round(157 / 0.056), pitchMm: 0.056, focalMm: 1524 }

// A point in the panoramic camera's frame (x along the scan, y down, z forward) → its
// pixel-edge position on the strip: the film is a cylinder of radius f round y.
function stripPixel(P, s = strip) {
  const theta = Math.atan2(P[0], P[2]), t = s.focalMm * P[1] / Math.hypot(P[0], P[2])
  return { u: s.width / 2 + s.focalMm * theta / s.pitchMm, v: s.height / 2 + t / s.pitchMm }
}
// The same point through segment k's pinhole: the camera turned by θk about y.
function segmentPixel(P, seg, s = strip) {
  const c = Math.cos(seg.thetaRad), sn = Math.sin(seg.thetaRad)
  const x = P[0] * c - P[2] * sn, z = P[0] * sn + P[2] * c
  return { a: seg.width / 2 + s.focalMm * x / z / s.pitchMm, b: seg.height / 2 + s.focalMm * P[1] / z / s.pitchMm }
}

describe('panoramic strips as frame-camera segments', () => {
  it('cuts a strip into near-square segments covering its scan', () => {
    const layout = panoramicSegments(strip)
    expect(layout.axis).toBe('x')
    expect(layout.scanRad).toBeCloseTo(Math.PI / 2, 3)
    expect(layout.segments).toHaveLength(Math.round(strip.width / strip.height))
    const seg = layout.segments[0]
    // 10 % overlap each side: 1.2 × the core width, and a little taller than the strip.
    expect(seg.width / (strip.width / layout.segments.length)).toBeCloseTo(1.2, 1)
    expect(seg.height).toBeGreaterThanOrEqual(strip.height)
    expect(seg.cx).toBe(seg.width / 2 - 0.5)
    expect(layout.segments.at(-1).thetaRad).toBeCloseTo(-layout.segments[0].thetaRad, 9)
    expect(panoramicSegments(strip, { segments: 4 }).segments).toHaveLength(4)
  })

  it('samples exactly what a pinhole turned to the segment sees', () => {
    const layout = panoramicSegments(strip, { segments: 12 })
    let worst = 0
    for (const seg of layout.segments) {
      for (const [x, y] of [[-0.5, -0.5], [0.5, 0.4], [0, 0], [0.3, -0.45], [-0.45, 0.1]]) {
        // A ray inside the segment, at a far point on it.
        const ang = seg.thetaRad + x * 2 * seg.halfRad * 0.95
        const P = [Math.sin(ang) * 2e5, y * 0.9 * strip.height * strip.pitchMm / strip.focalMm * 2e5, Math.cos(ang) * 2e5]
        const want = stripPixel(P), at = segmentPixel(P, seg)
        const got = segmentToStrip(seg, layout, strip, at.a, at.b)
        worst = Math.max(worst, Math.hypot(got.u - want.u, got.v - want.v))
        const back = stripToSegment(seg, layout, strip, want.u, want.v)
        worst = Math.max(worst, Math.hypot(back.a - at.a, back.b - at.b))
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('maps a segment centre to its scan angle and the strip mid-height', () => {
    const layout = panoramicSegments(strip, { segments: 5 })
    const seg = layout.segments[1]
    const { u, v } = segmentToStrip(seg, layout, strip, seg.width / 2, seg.height / 2)
    expect(u).toBeCloseTo(strip.width / 2 + seg.thetaRad * strip.focalMm / strip.pitchMm, 6)
    expect(v).toBeCloseTo(strip.height / 2, 6)
    expect(stripToSegment(seg, layout, strip, 0, 0)).not.toBeNull()
    // The strip's far end (θ = −45°) is 81° off the last segment's axis (+36°): not shown.
    expect(stripToSegment(layout.segments[4], layout, strip, 0, strip.height / 2)).toBeNull()
  })

  it('handles a strip whose scan runs down the image', () => {
    const tall = { ...strip, width: strip.height, height: strip.width }
    const layout = panoramicSegments(tall, { segments: 6 })
    expect(layout.axis).toBe('y')
    const seg = layout.segments[2]
    const P = [Math.sin(seg.thetaRad) * 1e5, 0.01 * 1e5, Math.cos(seg.thetaRad) * 1e5]
    const at = segmentPixel(P, seg, tall)
    const got = segmentToStrip(seg, layout, tall, at.a, at.b)
    const theta = Math.atan2(P[0], P[2]), t = tall.focalMm * P[1] / Math.hypot(P[0], P[2])
    expect(got.v).toBeCloseTo(tall.height / 2 + tall.focalMm * theta / tall.pitchMm, 6)
    expect(got.u).toBeCloseTo(tall.width / 2 + t / tall.pitchMm, 6)
  })

  it('names segments after their strip, in scan order', () => {
    expect(segmentName('D3C1214-100097A013.tif', 0)).toBe('D3C1214-100097A013_s01.tif')
    expect(segmentName('F01.tif', 11)).toBe('F01_s12.tif')
  })
})
