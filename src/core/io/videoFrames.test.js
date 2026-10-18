import { describe, it, expect } from 'vitest'
import {
  isVideoFile, frameTimestamp, frameFileName, estimateFps, intervalTimes, analysisTimes,
  laplacianVariance, scoreFrame, measureMotion, motionPyramid, createMotionTracker,
  relativeSharpness, selectKeyframes, fitSize,
} from './videoFrames.js'

// A smooth random texture (a "scene") and crops of it (the "frames" of a pan).
function scene(w, h, seed = 7) {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  let d = new Float32Array(w * h).map(() => rnd())
  for (let pass = 0; pass < 3; pass++) {
    const out = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0, n = 0
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) { acc += d[yy * w + xx]; n++ }
        }
        out[y * w + x] = acc / n
      }
    }
    d = out
  }
  // Stretch to the full 0..1 range: a real frame has contrast, three blurs of
  // uniform noise hardly any.
  let lo = Infinity, hi = -Infinity
  for (const v of d) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
  return { d: d.map((v) => (v - lo) / (hi - lo)), w, h }
}
function crop(sc, x0, y0, w, h) {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = sc.d[(y0 + y) * sc.w + x0 + x]
  return out
}
function boxBlur(d, w, h, r) {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, n = 0
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy))
      acc += d[yy * w + xx]; n++
    }
    out[y * w + x] = acc / n
  }
  return out
}

describe('video files and names', () => {
  it('recognises videos by MIME type or extension', () => {
    expect(isVideoFile({ name: 'a.bin', type: 'video/mp4' })).toBe(true)
    expect(isVideoFile({ name: 'walk.MOV', type: '' })).toBe(true)
    expect(isVideoFile({ name: 'clip.webm' })).toBe(true)
    expect(isVideoFile({ name: 'IMG_1.jpg', type: 'image/jpeg' })).toBe(false)
    expect(isVideoFile({ name: 'points.las', type: '' })).toBe(false)
    expect(isVideoFile(null)).toBe(false)
  })

  it('names frames <video>_<timestamp> so they sort in time order', () => {
    expect(frameTimestamp(12.3456, 40)).toBe('00m12.346s')
    expect(frameTimestamp(62.5, 6000)).toBe('001m02.500s') // a 100-minute video pads to 3
    expect(frameFileName('walk around.mp4', 1.5, 30)).toBe('walk around_00m01.500s.jpg')
    expect(frameFileName('a/b:c.webm', 0, 10, 'png')).toBe('a_b_c_00m00.000s.png')
    const names = [0.5, 9.25, 10, 61, 119.999].map((t) => frameFileName('v.mp4', t, 120))
    expect([...names].sort()).toEqual(names)
  })
})

describe('timing', () => {
  it('estimates the frame rate from presented media times, tolerating dropped frames', () => {
    const t = [], fps = 29.97
    for (let i = 0; i < 40; i++) if (i % 7 !== 3) t.push(i / fps) // some frames dropped
    expect(estimateFps(t)).toBe(29.97)
    expect(estimateFps([0, 0.04, 0.08, 0.12, 0.16])).toBe(25)
    expect(estimateFps([0, 0.1])).toBeNull()
  })

  it('plans a fixed interval in seconds or frames', () => {
    expect(intervalTimes(5, { every: 2 })).toEqual([0, 2, 4])
    expect(intervalTimes(1, { every: 10, unit: 'frames', fps: 30 })).toEqual([0, 1 / 3, 2 / 3].map((v) => Math.round(v * 1e6) / 1e6))
    expect(intervalTimes(1, { every: 15, unit: 'frames' })).toEqual([0, 0.5]) // unknown rate → 30
    expect(intervalTimes(0, { every: 1 })).toEqual([])
    expect(intervalTimes(10, { every: 0 })).toEqual([])
  })

  it('samples the analysis pass at a few per second, sparser for long videos', () => {
    expect(analysisTimes(2).times).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75])
    const long = analysisTimes(3600)
    expect(long.times.length).toBeLessThanOrEqual(3000)
    expect(long.step).toBeCloseTo(1.2)
    expect(analysisTimes(1, 2).step).toBe(0.5) // never closer than a frame
  })

  it('fits a size inside a long side without upscaling', () => {
    expect(fitSize(1920, 1080, 512)).toEqual({ width: 512, height: 288 })
    expect(fitSize(400, 300, 512)).toEqual({ width: 400, height: 300 })
    expect(fitSize(1920, 1080, 0)).toEqual({ width: 1920, height: 1080 })
  })
})

describe('scores', () => {
  it('sharpness falls with blur', () => {
    const sc = scene(200, 120)
    const sharp = laplacianVariance(sc.d, sc.w, sc.h)
    const soft = laplacianVariance(boxBlur(sc.d, sc.w, sc.h, 2), sc.w, sc.h)
    expect(sharp).toBeGreaterThan(soft * 3)
    expect(laplacianVariance(new Float32Array(100).fill(0.5), 10, 10)).toBe(0)
  })

  it('scoreFrame reduces to the motion size', () => {
    const sc = scene(320, 180)
    const r = scoreFrame(sc.d, sc.w, sc.h, { sharpDim: 256, motionDim: 160 })
    expect([r.motionW, r.motionH]).toEqual([160, 90])
    expect(r.motion.length).toBe(160 * 90)
    expect(r.sharpness).toBeGreaterThan(0)
  })
})

describe('motion', () => {
  const sc = scene(480, 160)
  const W = 160, H = 90

  it('measures a pan as the shift over the frame width', () => {
    const a = motionPyramid(crop(sc, 40, 30, W, H), W, H)
    for (const dx of [0, 3, 8, 20]) {
      const b = motionPyramid(crop(sc, 40 + dx, 30, W, H), W, H)
      const m = measureMotion(a, b)
      expect(m.motion * W).toBeCloseTo(dx, 0)
    }
    const diag = measureMotion(a, motionPyramid(crop(sc, 46, 22, W, H), W, H))
    expect(diag.motion * W).toBeCloseTo(10, 0)
  })

  it('accumulates slow drift (sub-pixel steps) and ignores a still camera', () => {
    // Drift of 0.5 px per sample: one pixel every other sample in the crops.
    const tr = createMotionTracker()
    let r
    for (let i = 0; i <= 120; i++) r = tr.push(crop(sc, 40 + Math.floor(i / 2), 30, W, H), W, H)
    expect(r.travel * W).toBeGreaterThan(50)
    expect(r.travel * W).toBeLessThan(70)
    const still = createMotionTracker()
    for (let i = 0; i < 50; i++) r = still.push(crop(sc, 100, 30, W, H), W, H)
    expect(r.travel).toBeLessThan(1e-3)
  })

  it('treats a cut as a full frame of travel', () => {
    const tr = createMotionTracker()
    tr.push(crop(sc, 0, 0, W, H), W, H)
    const other = scene(W, H, 99)
    const r = tr.push(other.d, W, H)
    expect(r.lost).toBe(true)
    expect(r.travel).toBeGreaterThanOrEqual(1)
  })
})

describe('keyframe selection', () => {
  // Constant speed: 0.05 frame widths per sample, all equally sharp.
  const steady = (n, speed = 0.05, sharp = () => 1) =>
    Array.from({ length: n }, (_, i) => ({ t: i * 0.25, travel: i * speed, sharpness: sharp(i) }))

  it('spaces frames by travel for the requested overlap', () => {
    const r = selectKeyframes(steady(101), { overlap: 80, maxFrames: 0 })
    const travel = r.indices.map((i) => i * 0.05)
    for (let k = 1; k < travel.length; k++) {
      const d = travel[k] - travel[k - 1]
      expect(d).toBeGreaterThanOrEqual(0.1 - 1e-9)
      expect(d).toBeLessThanOrEqual(0.2 + 1e-9)
    }
    expect(r.indices.length).toBeGreaterThanOrEqual(25)
    expect(r.indices.length).toBeLessThanOrEqual(51)
    expect(r.times).toEqual(r.indices.map((i) => i * 0.25))
  })

  it('takes one frame while the camera stands still', () => {
    const samples = [
      ...Array.from({ length: 40 }, (_, i) => ({ t: i, travel: 0, sharpness: 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ t: 40 + i, travel: (i + 1) * 0.1, sharpness: 1 })),
    ]
    const r = selectKeyframes(samples, { overlap: 80 })
    expect(r.indices.filter((i) => i < 40)).toHaveLength(1)
    expect(r.indices.length).toBeLessThanOrEqual(1 + 10)
  })

  it('picks the sharpest frame in each window and skips blurry ones', () => {
    // Every fourth sample is blurry (a tenth of the rest), every fourth a bit sharper.
    const samples = steady(90, 0.05, (i) => (i % 4 === 1 ? 0.1 : i % 4 === 3 ? 1.2 : 1))
    const r = selectKeyframes(samples, { overlap: 80, minSharpness: 0.5, maxFrames: 0 })
    expect(r.indices.some((i) => i % 4 === 1)).toBe(false)
    // Windows span 3 samples; one in two of those holds a sharper (i % 4 === 3) sample.
    expect(r.indices.filter((i) => i % 4 === 3).length).toBeGreaterThan(r.indices.length / 3)
    expect(r.blurry).toBe(23)
    expect(r.blurryKept).toBe(0)
  })

  it('keeps a blurry frame rather than break the sequence', () => {
    // A long blurry stretch (samples 20–59) in the middle of a sharp video.
    const samples = steady(80, 0.05, (i) => (i >= 20 && i < 60 ? 0.05 : 1))
    const r = selectKeyframes(samples, { overlap: 80, minSharpness: 0.5, window: 101, maxFrames: 0 })
    const travel = r.indices.map((i) => samples[i].travel)
    for (let k = 1; k < travel.length; k++) expect(travel[k] - travel[k - 1]).toBeLessThanOrEqual(0.4 + 1e-9)
    expect(r.blurryKept).toBeGreaterThan(0)
  })

  it('records a gap when the view jumps past a whole window', () => {
    const samples = [0, 0.05, 0.1, 0.9, 0.95, 1.0].map((travel, i) => ({ t: i, travel, sharpness: 1 }))
    const r = selectKeyframes(samples, { overlap: 80 })
    expect(r.gaps).toBe(1)
    expect(r.indices).toContain(3)
  })

  it('widens the spacing to respect the frame cap', () => {
    const samples = steady(400, 0.05)
    const free = selectKeyframes(samples, { overlap: 90, maxFrames: 0 })
    expect(free.indices.length).toBeGreaterThan(100)
    const capped = selectKeyframes(samples, { overlap: 90, maxFrames: 40 })
    expect(capped.indices.length).toBeLessThanOrEqual(40)
    expect(capped.indices.length).toBeGreaterThan(30)
    expect(capped.step).toBeGreaterThan(0.1)
    expect(capped.overlap).toBeLessThan(90)
  })

  it('compares sharpness with its neighbourhood, not the whole video', () => {
    const v = [...Array(20).fill(10), ...Array(20).fill(1)]
    const rel = relativeSharpness(v, 5)
    expect(rel[5]).toBeCloseTo(1)
    expect(rel[30]).toBeCloseTo(1)
    expect(selectKeyframes([], {}).indices).toEqual([])
  })
})
