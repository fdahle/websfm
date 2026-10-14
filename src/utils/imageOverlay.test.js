import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  overlayView, beginOverlayFrame, paintRaster, paintRampLegend, paintResidualLegend,
  keypointResponseRange, paintKeypoints, paintResiduals, residualColor, RESIDUAL_AMP,
  pointGuideLabel, paintGcpGuides, paintGcps, paintFiducials, paintLoupe,
  paintBrushCursor, paintRectPreview, KEYPOINT_LEGEND, DEPTH_LEGEND,
} from './imageOverlay.js'

// A fake 2D context recording every call and property write, in order. measureText
// is 6 px per character so label boxes are checkable.
function fakeCtx() {
  const calls = []
  const state = {}
  const rec = (name) => (...args) => { calls.push([name, ...args]); return undefined }
  const methods = ['save', 'restore', 'setTransform', 'clearRect', 'drawImage', 'beginPath', 'moveTo', 'lineTo',
    'arc', 'stroke', 'fill', 'fillRect', 'strokeRect', 'fillText', 'rect', 'clip', 'setLineDash']
  const ctx = new Proxy({}, {
    get(_, k) {
      if (methods.includes(k)) return rec(k)
      if (k === 'measureText') return (t) => ({ width: t.length * 6 })
      if (k === 'createLinearGradient') return (...a) => { calls.push(['createLinearGradient', ...a]); return { addColorStop: rec('addColorStop') } }
      return state[k]
    },
    set(_, k, v) { state[k] = v; calls.push(['set', k, v]); return true },
  })
  const of = (name) => calls.filter((c) => c[0] === name)
  return { ctx, calls, of, state }
}

// 1000×500 native image shown at scale 0.5, panned by (10, 20), in an 800×600 viewport.
const FRAME = { width: 1000, height: 500, naturalWidth: 1000, naturalHeight: 500, bitmapScale: 1, preview: false, exact: true }
const view = overlayView({ w: 800, h: 600, tx: 10, ty: 20, scale: 0.5, frame: FRAME })

// Path2D is a browser global; record the sub-paths per instance.
class FakePath2D {
  constructor() { this.ops = []; FakePath2D.made.push(this) }
  moveTo(x, y) { this.ops.push(['moveTo', x, y]) }
  arc(x, y) { this.ops.push(['arc', x, y]) }
}
FakePath2D.made = []
let savedPath2D
beforeAll(() => { savedPath2D = globalThis.Path2D; globalThis.Path2D = FakePath2D })
afterAll(() => { globalThis.Path2D = savedPath2D })

describe('overlayView', () => {
  it('derives the on-screen image size from the NATIVE frame', () => {
    // A preview bitmap 20× smaller still displays at native size × scale.
    const preview = { ...FRAME, naturalWidth: 50, naturalHeight: 25, bitmapScale: 0.05, preview: true }
    expect(overlayView({ w: 800, h: 600, tx: 0, ty: 0, scale: 0.5, frame: preview }))
      .toMatchObject({ nw: 1000, nh: 500, dispW: 500, dispH: 250 })
    expect(view).toMatchObject({ w: 800, h: 600, tx: 10, ty: 20, scale: 0.5, dispW: 500, dispH: 250 })
  })
})

describe('beginOverlayFrame', () => {
  it('resizes the canvas to device px only when the size changed, then clears in CSS px', () => {
    const { ctx, of } = fakeCtx()
    const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx }
    expect(beginOverlayFrame(canvas, 400, 300, 2)).toBe(ctx)
    expect(canvas).toMatchObject({ width: 800, height: 600, style: { width: '400px', height: '300px' } })
    expect(of('setTransform')[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0])
    expect(of('clearRect')[0]).toEqual(['clearRect', 0, 0, 400, 300])
    canvas.style = {} // a second frame at the same size leaves the canvas alone
    beginOverlayFrame(canvas, 400, 300, 2)
    expect(canvas.style).toEqual({})
  })
})

describe('legends', () => {
  it('stack up from the bottom-left corner, one row per slot', () => {
    const { ctx, of } = fakeCtx()
    paintRampLegend(ctx, view, 0, DEPTH_LEGEND)
    paintRampLegend(ctx, view, 1, KEYPOINT_LEGEND)
    const boxes = of('fillRect').filter((c) => c[3] === 80) // the 72+8 px backdrops
    expect(boxes.map((c) => c[2])).toEqual([600 - 36 - 14, 600 - 36 - 34 - 14])
    expect(of('fillText').map((c) => c[1])).toEqual(['near', 'far', 'depth', 'low', 'high', 'response'])
    expect(of('addColorStop')).toHaveLength(DEPTH_LEGEND.stops.length + KEYPOINT_LEGEND.stops.length)
  })

  it('captions the residual overlay', () => {
    const { ctx, of } = fakeCtx()
    paintResidualLegend(ctx, view, 2)
    expect(of('fillText')[0]).toEqual(['fillText', '×25  red > 2 px', 12, 600 - 36 - 68 + 5])
  })
})

describe('paintRaster', () => {
  it('stretches the source over the image rect at the given alpha', () => {
    const { ctx, calls } = fakeCtx()
    const src = {}
    paintRaster(ctx, view, src, 0.6)
    expect(calls).toEqual([['save'], ['set', 'globalAlpha', 0.6], ['drawImage', src, 10, 20, 500, 250], ['restore']])
  })

  it('turns smoothing on only when asked (the low-res Smart Select preview)', () => {
    const { ctx, calls } = fakeCtx()
    paintRaster(ctx, view, {}, 0.55, { smooth: true })
    expect(calls[1]).toEqual(['set', 'imageSmoothingEnabled', true])
  })
})

// Typed keypoint set stand-in (core/features/keypoints.js): normalized nx/ny.
function kpSet(points) {
  return {
    length: points.length,
    nx: (i) => points[i].nx, ny: (i) => points[i].ny, response: (i) => points[i].r,
  }
}

describe('keypoints', () => {
  it('response range: null when empty, never a zero range', () => {
    expect(keypointResponseRange(null)).toBeNull()
    expect(keypointResponseRange(kpSet([]))).toBeNull()
    expect(keypointResponseRange(kpSet([{ r: 3 }, { r: 3 }]))).toEqual({ minR: 3, range: 1 })
    expect(keypointResponseRange(kpSet([{ r: 1 }, { r: 5 }, { r: 2 }]))).toEqual({ minR: 1, range: 4 })
  })

  it('culls off-screen points and fills one path per hue bucket, cold to hot', () => {
    FakePath2D.made = []
    const { ctx, of, calls } = fakeCtx()
    const kps = kpSet([
      { nx: 0, ny: 0, r: 0 },       // → (10, 20), coldest
      { nx: 1, ny: 1, r: 10 },      // → (510, 270), hottest
      { nx: 0.5, ny: 0.5, r: 10 },  // hottest again: same bucket, same path
      { nx: 2, ny: 0, r: 5 },       // → x = 1010, off the 800 px viewport: culled
    ])
    paintKeypoints(ctx, view, kps, keypointResponseRange(kps))
    expect(FakePath2D.made).toHaveLength(2)
    expect(of('fill')).toHaveLength(2)
    // Buckets are filled in index order: blue (cold) first, then red (hot).
    const styles = calls.filter((c) => c[0] === 'set' && c[1] === 'fillStyle').map((c) => c[2])
    expect(styles).toEqual(['hsl(240,100%,55%)', 'hsl(0,100%,55%)'])
    const hot = FakePath2D.made[1].ops.filter((o) => o[0] === 'arc')
    expect(hot).toEqual([['arc', 510, 270], ['arc', 260, 145]])
  })
})

describe('paintResiduals', () => {
  it('draws amplified vectors from the observation, coloured by raw magnitude', () => {
    const { ctx, of } = fakeCtx()
    paintResiduals(ctx, view, [{ px: 100, py: 100, du: 1, dv: 0, mag: 1 }])
    // (100,100) native → (60, 70) screen; +25 px native → +12.5 px screen.
    expect(of('moveTo')[0]).toEqual(['moveTo', 60, 70])
    expect(of('lineTo')[0]).toEqual(['lineTo', 60 + RESIDUAL_AMP * 0.5, 70])
    expect([0.5, 1, 2.5].map(residualColor)).toEqual(['#3fca77', '#e6a01e', '#e0533d'])
  })
})

describe('GCP guides', () => {
  const clip = () => [{ x: 0, y: 0 }, { x: 1000, y: 500 }]

  it('label counts the marks the prediction used', () => {
    expect(pointGuideLabel({ name: 'G1', viewCount: 9 })).toBe('G1 — mark here (9 marks)')
    expect(pointGuideLabel({ name: 'G1', viewCount: 9, rejectedCount: 2 })).toBe('G1 — mark here (7 of 9 marks)')
  })

  it('draws an epipolar line only for the selected GCP', () => {
    const line = { gcpId: 'a', name: 'A', kind: 'line', line: [1, 0, 0] }
    const { ctx, of } = fakeCtx()
    paintGcpGuides(ctx, view, [line], 'b', clip)
    expect(of('stroke')).toHaveLength(0)
    const sel = fakeCtx()
    paintGcpGuides(sel.ctx, view, [line], 'a', clip)
    expect(sel.of('moveTo')[0]).toEqual(['moveTo', 10, 20])
    expect(sel.of('lineTo')[0]).toEqual(['lineTo', 510, 270])
    expect(sel.of('fillText')[0][1]).toBe('A — on this line')
  })

  it('skips a point prediction outside the frame and labels only the selected one', () => {
    const { ctx, of } = fakeCtx()
    paintGcpGuides(ctx, view, [
      { gcpId: 'a', name: 'A', kind: 'point', u: 1200, v: 10, viewCount: 2 }, // off-frame
      { gcpId: 'b', name: 'B', kind: 'point', u: 100, v: 100, viewCount: 3 },
      { gcpId: 'c', name: 'C', kind: 'point', u: 200, v: 100, viewCount: 4 },
    ], 'c', clip)
    expect(of('arc').map((c) => [c[1], c[2]])).toEqual([[60, 70], [110, 70]])
    expect(of('fillText').map((c) => c[1])).toEqual(['C — mark here (4 marks)'])
  })
})

describe('paintGcps', () => {
  it('rings each placed observation and shows the live reprojection error', () => {
    const { ctx, of, calls } = fakeCtx()
    paintGcps(ctx, view, [
      { id: 'a', name: 'A', px: 100, py: 100, reprojPx: 7.25 },
      { id: 'b', name: 'B', px: null, py: 5 },             // not marked: skipped
      { id: 'c', name: 'C', px: 0, py: 0, reprojPx: 1 },
    ], 'c')
    expect(of('arc').map((c) => [c[1], c[2]])).toEqual([[60, 70], [10, 20]])
    expect(of('fillText').map((c) => c[1])).toEqual(['A', '  7.3px', 'C', '  1.0px'])
    const fills = calls.filter((c) => c[0] === 'set' && c[1] === 'fillStyle').map((c) => c[2])
    expect(fills).toContain('rgba(255,90,90,0.95)')   // A's 7.3 px > 5 px: red
    expect(fills).toContain('rgba(80,200,255,0.95)')  // C is selected: blue label
  })
})

describe('paintFiducials', () => {
  it('labels marks with their residual (red past 12 µm) and draws ghost guides dashed', () => {
    const { ctx, of, calls } = fakeCtx()
    paintFiducials(ctx, view,
      [{ fidId: 'F1', px: 100, py: 100 }, { fidId: 'F2', px: 0, py: 0 }],
      new Map([['F1', 20], ['F2', 3]]),
      [{ id: 'F3', px: 200, py: 100 }])
    expect(of('strokeRect').map((c) => [c[1], c[2]])).toEqual([[54, 64], [4, 14], [104, 64]])
    expect(of('fillText').map((c) => c[1])).toEqual(['F1', '  20.0µm', 'F2', '  3.0µm', 'F3'])
    const fills = calls.filter((c) => c[0] === 'set' && c[1] === 'fillStyle').map((c) => c[2])
    expect(fills.filter((f) => f === 'rgba(255,90,90,0.95)')).toHaveLength(1)
    expect(of('setLineDash')[0]).toEqual(['setLineDash', [3, 3]])
  })
})

describe('paintLoupe', () => {
  it('samples the bitmap around the cursor through bitmapScale, pinned top-right', () => {
    const { ctx, of } = fakeCtx()
    const img = {}
    const preview = { ...FRAME, naturalWidth: 100, naturalHeight: 50, bitmapScale: 0.1, preview: true }
    paintLoupe(ctx, view, img, preview, { x: 60, y: 70 }) // native (100, 100) → bitmap (10, 10)
    const [, src, sx, sy, sw, sh, dx, dy, dw, dh] = of('drawImage')[0]
    expect(src).toBe(img)
    expect([sx, sy, sw, sh]).toEqual([10 - 0.8, 10 - 0.8, 1.6, 1.6])
    expect([dx, dy, dw, dh]).toEqual([800 - 128 - 12, 12, 128, 128])
  })

  it('draws nothing off the image or for an inexact frame', () => {
    const off = fakeCtx()
    paintLoupe(off.ctx, view, {}, FRAME, { x: 5, y: 5 })
    expect(off.calls).toEqual([])
    const inexact = fakeCtx()
    paintLoupe(inexact.ctx, view, {}, { ...FRAME, exact: false }, { x: 60, y: 70 })
    expect(inexact.calls).toEqual([])
  })
})

describe('mask-edit cursors', () => {
  it('brush cursor is red, the eraser blue', () => {
    const brush = fakeCtx(), erase = fakeCtx()
    paintBrushCursor(brush.ctx, { x: 1, y: 2 }, 20, false)
    paintBrushCursor(erase.ctx, { x: 1, y: 2 }, 20, true)
    expect(brush.of('arc')[0]).toEqual(['arc', 1, 2, 20, 0, Math.PI * 2])
    expect(brush.state.strokeStyle).toBe('rgba(255,80,80,0.9)')
    expect(erase.state.strokeStyle).toBe('rgba(100,180,255,0.9)')
  })

  it('rectangle preview normalizes the corners into screen px', () => {
    const { ctx, of } = fakeCtx()
    paintRectPreview(ctx, view, { x0: 200, y0: 100, x1: 100, y1: 300, erase: true })
    expect(of('strokeRect')[0]).toEqual(['strokeRect', 60, 70, 50, 100])
  })
})
