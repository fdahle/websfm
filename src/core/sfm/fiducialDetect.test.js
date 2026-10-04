import { describe, it, expect } from 'vitest'
import {
  FIDUCIAL_DETECT_TUNING,
  grayFromRgba,
  extractPatch,
  downscalePatch,
  rotatePatch90,
  rotatePoint90,
  matchZNCC,
  subpixelPeak,
  detectFiducialsInImage,
} from './fiducialDetect.js'

// ── synthetic raster helpers ───────────────────────────────────────────────

// Deterministic PRNG so the "noise" background is reproducible across runs — a
// flat background would make every window equally correlated and the test would
// measure nothing.
function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function blankImage(width, height, seed = 1) {
  const r = rng(seed)
  const data = new Float32Array(width * height)
  for (let i = 0; i < data.length; i++) data[i] = 110 + r() * 20 // faint texture
  return { data, width, height }
}

// A fiducial-like mark: a filled dot inside a ring, plus a solid block off to one
// side. The block is what makes the pattern rotationally ASYMMETRIC, and it is
// deliberately chunky (6×6 px) so the asymmetry survives the coarse downscale —
// the rotation probe runs on the coarse image, and a one-pixel-wide tick would
// simply average away. `symmetric: true` omits it, for the guard test.
function drawMark(img, cx, cy, { symmetric = false } = {}) {
  const set = (x, y, v) => {
    if (x >= 0 && y >= 0 && x < img.width && y < img.height) img.data[y * img.width + x] = v
  }
  for (let dy = -10; dy <= 10; dy++) {
    for (let dx = -10; dx <= 10; dx++) {
      const d = Math.hypot(dx, dy)
      if (d < 3) set(cx + dx, cy + dy, 20)                    // dot
      else if (d > 7.5 && d < 9.5) set(cx + dx, cy + dy, 235) // ring
    }
  }
  if (!symmetric) {
    for (let dy = -14; dy <= -9; dy++) {
      for (let dx = 9; dx <= 14; dx++) set(cx + dx, cy + dy, 250) // block, up-right
    }
  }
  return img
}

function bilinear(img, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const fx = x - x0, fy = y - y0
  const px = (xx, yy) => {
    const cx = Math.min(img.width - 1, Math.max(0, xx))
    const cy = Math.min(img.height - 1, Math.max(0, yy))
    return img.data[cy * img.width + cx]
  }
  return (
    px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) +
    px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy
  )
}

// shifted[x,y] = orig[x−dx, y−dy] ⇒ a feature at p appears at p + (dx, dy).
function shiftImage(img, dx, dy) {
  const data = new Float32Array(img.width * img.height)
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) data[y * img.width + x] = bilinear(img, x - dx, y - dy)
  }
  return { data, width: img.width, height: img.height }
}

// Rotate a whole image k·90° CW. Point mapping is rotatePoint90's, inverted:
// new[newY][newX] = old[H−1−newX][newY] for k=1.
function rotateImage90(img, k) {
  const kk = ((k % 4) + 4) % 4
  let cur = img
  for (let step = 0; step < kk; step++) {
    const W = cur.width, H = cur.height
    const data = new Float32Array(W * H)
    for (let ny = 0; ny < W; ny++) {
      for (let nx = 0; nx < H; nx++) data[ny * H + nx] = cur.data[(H - 1 - nx) * W + ny]
    }
    cur = { data, width: H, height: W }
  }
  return cur
}

// Box-downscale a whole image, mirroring what the worker's scaled drawImage
// produces. `scale` is reported as the ACTUAL drawn ratio, like the worker does.
function coarseOf(img, scale) {
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const data = new Float32Array(w * h)
  const sx = img.width / w, sy = img.height / h
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let sum = 0, n = 0
      for (let y = Math.floor(r * sy); y < Math.floor((r + 1) * sy); y++) {
        for (let x = Math.floor(c * sx); x < Math.floor((c + 1) * sx); x++) {
          sum += img.data[y * img.width + x]; n++
        }
      }
      data[r * w + c] = n ? sum / n : 0
    }
  }
  return { data, width: w, height: h, scale: w / img.width, natW: img.width, natH: img.height }
}

// The worker's cropWindow, done over a full-res array (tests have no canvas).
function makeCropWindow(img) {
  return (cx, cy, half) => {
    const x0 = Math.round(cx) - half, y0 = Math.round(cy) - half
    const size = 2 * half + 1
    const data = new Float32Array(size * size)
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const sx = Math.min(img.width - 1, Math.max(0, x0 + c))
        const sy = Math.min(img.height - 1, Math.max(0, y0 + r))
        data[r * size + c] = img.data[sy * img.width + sx]
      }
    }
    return { data, width: size, height: size, originX: x0, originY: y0 }
  }
}

// ── primitives ─────────────────────────────────────────────────────────────

describe('grayFromRgba', () => {
  it('applies Rec. 601 luma', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255])
    const g = grayFromRgba(rgba, 2, 1)
    expect(g.data[0]).toBeCloseTo(255 * 0.299, 4)
    expect(g.data[1]).toBeCloseTo(255 * 0.587, 4)
  })
})

describe('extractPatch', () => {
  it('edge-clamps out-of-bounds source pixels', () => {
    const img = { data: Float32Array.from([1, 2, 3, 4]), width: 2, height: 2 }
    const p = extractPatch(img, 0, 0, 1)
    expect(p.size).toBe(3)
    // Row 0 clamps up to row 0; column 0 clamps left to column 0.
    expect(Array.from(p.data)).toEqual([1, 1, 2, 1, 1, 2, 3, 3, 4])
  })

  it('returns null when the centre is outside the image', () => {
    const img = { data: new Float32Array(4), width: 2, height: 2 }
    expect(extractPatch(img, 5, 0, 1)).toBeNull()
  })
})

describe('rotatePatch90', () => {
  it('rotates clockwise', () => {
    const p = { data: Float32Array.from([1, 2, 3, 4]), size: 2 } // [[1,2],[3,4]]
    expect(Array.from(rotatePatch90(p, 1).data)).toEqual([3, 1, 4, 2])
    expect(Array.from(rotatePatch90(p, 2).data)).toEqual([4, 3, 2, 1])
    expect(Array.from(rotatePatch90(p, 3).data)).toEqual([2, 4, 1, 3])
    expect(Array.from(rotatePatch90(p, 0).data)).toEqual([1, 2, 3, 4])
  })
})

describe('rotatePoint90', () => {
  it('agrees with a rotated raster on a non-square image', () => {
    const img = drawMark(blankImage(40, 24, 7), 12, 8)
    for (let k = 0; k < 4; k++) {
      const rot = rotateImage90(img, k)
      const p = rotatePoint90(12, 8, k, 40, 24)
      expect(rot.data[p.y * rot.width + p.x]).toBe(img.data[8 * 40 + 12])
    }
  })
})

describe('downscalePatch', () => {
  it('box-averages to the requested size', () => {
    const p = { data: Float32Array.from([1, 3, 5, 7]), size: 2 }
    const d = downscalePatch(p, 0.5)
    expect(d.size).toBe(1)
    expect(d.data[0]).toBeCloseTo(4, 6)
  })
})

// ── matching ───────────────────────────────────────────────────────────────

describe('matchZNCC', () => {
  it('recovers a planted template exactly', () => {
    const img = drawMark(blankImage(200, 200, 3), 80, 80)
    const tpl = extractPatch(img, 80, 80, 16)
    const hit = matchZNCC(img, tpl, 60, 60, 100, 100)
    expect(hit.x).toBe(80)
    expect(hit.y).toBe(80)
    expect(hit.score).toBeGreaterThan(0.95)
  })

  it('survives heavy additive noise', () => {
    const clean = drawMark(blankImage(200, 200, 5), 120, 60)
    const tpl = extractPatch(clean, 120, 60, 16)
    const r = rng(99)
    const noisy = { ...clean, data: Float32Array.from(clean.data) }
    for (let i = 0; i < noisy.data.length; i++) {
      // Box–Muller, σ = 10 on a 0..255 range.
      const u = Math.max(1e-9, r()), v = r()
      noisy.data[i] += Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 10
    }
    const hit = matchZNCC(noisy, tpl, 100, 40, 140, 80)
    expect(Math.hypot(hit.x - 120, hit.y - 60)).toBeLessThanOrEqual(1)
    expect(hit.score).toBeGreaterThan(0.7)
  })

  it('scores low where the mark is absent', () => {
    const withMark = drawMark(blankImage(200, 200, 11), 50, 50)
    const tpl = extractPatch(withMark, 50, 50, 16)
    const blank = blankImage(200, 200, 12) // texture only, no mark anywhere
    const hit = matchZNCC(blank, tpl, 130, 130, 170, 170)
    expect(hit.score).toBeLessThan(0.3)
  })

  it('returns 0 (not NaN) on a flat window', () => {
    const withMark = drawMark(blankImage(200, 200, 13), 50, 50)
    const tpl = extractPatch(withMark, 50, 50, 16)
    const flat = { data: new Float32Array(200 * 200).fill(128), width: 200, height: 200 }
    const hit = matchZNCC(flat, tpl, 100, 100, 110, 110)
    expect(hit.score).toBe(0)
    expect(Number.isNaN(hit.score)).toBe(false)
  })
})

describe('subpixelPeak', () => {
  it('recovers a sub-pixel shift', () => {
    const img = drawMark(blankImage(200, 200, 17), 100, 100)
    const tpl = extractPatch(img, 100, 100, 16)
    const shifted = shiftImage(img, 0.3, -0.4)
    const hit = matchZNCC(shifted, tpl, 95, 95, 105, 105)
    const sub = subpixelPeak(shifted, tpl, hit.x, hit.y)
    // ~0.1 px of residual bias is expected and not a defect: the resampled
    // target is slightly blurred relative to the un-resampled template, which
    // flattens the ZNCC peak and pulls the parabola vertex toward the integer
    // sample. Well inside the tolerance that matters (the affine fit averages
    // over 4–8 marks).
    expect(Math.abs(sub.x - 100.3)).toBeLessThan(0.15)
    expect(Math.abs(sub.y - 99.6)).toBeLessThan(0.15)
  })
})

// ── orchestrator ───────────────────────────────────────────────────────────

// Four marks in a 240×180 frame; the templates come from the same raster, which
// is exactly the real setup (templates are cut from the reference image).
// The layout is deliberately ASYMMETRIC. Fiducial marks are identical to each
// other, so with the textbook symmetric 4-corner rectangle a wrong rotation maps
// every mark onto some other real mark and the rotation probe is undecidable by
// construction (pinned as its own test below). An asymmetric layout is what lets
// the rotation test actually exercise the mechanism.
function buildScene(seed = 23) {
  const marks = [
    { fidId: 'A', x: 40, y: 35 },
    { fidId: 'B', x: 200, y: 52 },
    { fidId: 'C', x: 66, y: 145 },
    { fidId: 'D', x: 188, y: 122 },
  ]
  const img = blankImage(240, 180, seed)
  for (const m of marks) drawMark(img, m.x, m.y)
  const templates = marks.map((m) => ({ fidId: m.fidId, patch: extractPatch(img, m.x, m.y, 16) }))
  return { img, marks, templates }
}

const CFG = { templateHalf: 16, coarseScale: 1 / 4, refineHalf: 24 }

describe('detectFiducialsInImage', () => {
  it('finds every mark in an unrotated target', () => {
    const { img, marks, templates } = buildScene()
    const predictions = marks.map((m) => ({ fidId: m.fidId, px: m.x + 5, py: m.y - 4, radius: 12 }))
    const out = detectFiducialsInImage({
      coarse: coarseOf(img, CFG.coarseScale), templates, predictions,
      cfg: { ...CFG, tryRotations: false },
      cropWindow: makeCropWindow(img),
    })
    expect(out).toHaveLength(4)
    for (const r of out) {
      const m = marks.find((mm) => mm.fidId === r.fidId)
      expect(Math.hypot(r.px - m.x, r.py - m.y)).toBeLessThan(0.5)
      expect(r.score).toBeGreaterThan(0.95)
    }
  })

  it('resolves a 90/180/270° scan rotation and maps positions back', () => {
    for (const k of [1, 2, 3]) {
      const { img, marks, templates } = buildScene()
      const target = rotateImage90(img, k)
      // Predictions stay in the REFERENCE frame — that is what the store has.
      const predictions = marks.map((m) => ({ fidId: m.fidId, px: m.x, py: m.y, radius: 10 }))
      const out = detectFiducialsInImage({
        coarse: coarseOf(target, CFG.coarseScale), templates, predictions,
        cfg: { ...CFG, tryRotations: true },
        cropWindow: makeCropWindow(target),
      })
      expect(out[0].rotationK, `k=${k}`).toBe(k)
      for (const r of out) {
        const m = marks.find((mm) => mm.fidId === r.fidId)
        const want = rotatePoint90(m.x, m.y, k, img.width, img.height)
        expect(Math.hypot(r.px - want.x, r.py - want.y), `${r.fidId} k=${k}`).toBeLessThan(0.5)
        expect(r.score).toBeGreaterThan(0.9)
      }
    }
  })

  it('falls back to k=0 when the rotation is genuinely undecidable', () => {
    // Rotationally symmetric marks scoring near-identically at all four k is the
    // undecidable case, and the probe must keep k=0 rather than pick one out of
    // noise — a wrong guess scrambles every search window at once, whereas k=0 is
    // right for every consistently-scanned batch. The same holds for identical
    // marks in a symmetric layout (see buildScene).
    const marks = [{ fidId: 'A', x: 60, y: 50 }, { fidId: 'B', x: 180, y: 130 }]
    const img = blankImage(240, 180, 31)
    for (const m of marks) drawMark(img, m.x, m.y, { symmetric: true })
    const templates = marks.map((m) => ({ fidId: m.fidId, patch: extractPatch(img, m.x, m.y, 16) }))
    const target = rotateImage90(img, 1)
    const out = detectFiducialsInImage({
      coarse: coarseOf(target, CFG.coarseScale),
      templates,
      predictions: marks.map((m) => ({ fidId: m.fidId, px: m.x, py: m.y, radius: 10 })),
      cfg: { ...CFG, tryRotations: true },
      cropWindow: makeCropWindow(target),
    })
    expect(out[0].rotationK).toBe(0)
  })

  it('keeps k=0 when the target is not rotated', () => {
    const { img, marks, templates } = buildScene()
    const out = detectFiducialsInImage({
      coarse: coarseOf(img, CFG.coarseScale), templates,
      predictions: marks.map((m) => ({ fidId: m.fidId, px: m.x, py: m.y, radius: 10 })),
      cfg: { ...CFG, tryRotations: true },
      cropWindow: makeCropWindow(img),
    })
    expect(out[0].rotationK).toBe(0)
  })

  it('runs coarse-only when no cropWindow is injected', () => {
    const { img, marks, templates } = buildScene()
    const out = detectFiducialsInImage({
      coarse: coarseOf(img, CFG.coarseScale), templates,
      predictions: marks.map((m) => ({ fidId: m.fidId, px: m.x, py: m.y, radius: 8 })),
      cfg: { ...CFG, tryRotations: false },
    })
    expect(out).toHaveLength(4)
    expect(out[0].score).toBe(out[0].coarseScore)
  })
})

describe('FIDUCIAL_DETECT_TUNING', () => {
  it('exposes the algorithm knobs', () => {
    expect(FIDUCIAL_DETECT_TUNING.templateHalf).toBeGreaterThan(0)
    expect(FIDUCIAL_DETECT_TUNING.coarseScale).toBeGreaterThan(0)
    expect(FIDUCIAL_DETECT_TUNING.coarseScale).toBeLessThanOrEqual(1)
    expect(FIDUCIAL_DETECT_TUNING.refineHalf).toBeGreaterThan(0)
  })
})
