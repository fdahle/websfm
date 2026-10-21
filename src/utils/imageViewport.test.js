import { describe, it, expect } from 'vitest'
import { imageFrame, fitView, zoomAbout, screenToImage, bitmapPixel } from './imageViewport.js'

// A 97 MP aerial scan and the ≤512 px preview the TIFF transcode shows first.
const NATIVE = { w: 11400, h: 8550 }
const PREVIEW = { w: 512, h: 384 }

describe('imageFrame', () => {
  it('is null before a bitmap has loaded', () => {
    expect(imageFrame({ naturalWidth: 0, naturalHeight: 0, metaWidth: 100, metaHeight: 100 })).toBeNull()
  })

  it('uses the bitmap itself once the full-resolution image is shown', () => {
    const f = imageFrame({ naturalWidth: NATIVE.w, naturalHeight: NATIVE.h, metaWidth: NATIVE.w, metaHeight: NATIVE.h })
    expect(f).toMatchObject({ width: NATIVE.w, height: NATIVE.h, bitmapScale: 1, preview: false, exact: true })
  })

  it('maps a flagged preview through the native size from metadata', () => {
    const f = imageFrame({
      naturalWidth: PREVIEW.w,
      naturalHeight: PREVIEW.h,
      metaWidth: NATIVE.w,
      metaHeight: NATIVE.h,
      lowRes: true,
    })
    expect(f).toMatchObject({ width: NATIVE.w, height: NATIVE.h, preview: true, exact: true })
    expect(f.bitmapScale).toBeCloseTo(PREVIEW.w / NATIVE.w)
  })

  it('treats an unflagged bitmap smaller than the recorded size as a preview too', () => {
    const f = imageFrame({
      naturalWidth: PREVIEW.w,
      naturalHeight: PREVIEW.h,
      metaWidth: NATIVE.w,
      metaHeight: NATIVE.h,
    })
    expect(f).toMatchObject({ width: NATIVE.w, height: NATIVE.h, preview: true, exact: true })
  })

  it('is a non-exact preview while the native size is unknown', () => {
    const f = imageFrame({
      naturalWidth: PREVIEW.w,
      naturalHeight: PREVIEW.h,
      metaWidth: null,
      metaHeight: null,
      lowRes: true,
    })
    expect(f).toMatchObject({ width: PREVIEW.w, height: PREVIEW.h, preview: true, exact: false })
  })

  it('ignores a recorded size whose aspect does not match the bitmap', () => {
    // e.g. width/height recorded swapped: never stretch the mapping onto it.
    const f = imageFrame({
      naturalWidth: PREVIEW.w,
      naturalHeight: PREVIEW.h,
      metaWidth: NATIVE.h,
      metaHeight: NATIVE.w,
      lowRes: true,
    })
    expect(f.exact).toBe(false)
    const full = imageFrame({ naturalWidth: 4000, naturalHeight: 3000, metaWidth: 3000, metaHeight: 4000 })
    expect(full).toMatchObject({ width: 4000, height: 3000, preview: false, exact: true })
  })
})

describe('fitView', () => {
  it('refuses to fit into an empty (v-show hidden) viewport', () => {
    expect(fitView(0, 0, NATIVE.w, NATIVE.h)).toBeNull()
    expect(fitView(800, 0, NATIVE.w, NATIVE.h)).toBeNull()
    expect(fitView(800, 600, 0, 0)).toBeNull()
  })

  it('centres the frame and never upscales past 1:1', () => {
    expect(fitView(1000, 1000, 500, 250)).toEqual({ scale: 1, tx: 250, ty: 375 })
    const v = fitView(1140, 1000, NATIVE.w, NATIVE.h)
    expect(v.scale).toBeCloseTo(0.1)
    expect(v.tx).toBeCloseTo(0)
    expect(v.ty).toBeCloseTo((1000 - NATIVE.h * 0.1) / 2)
  })
})

describe('zoomAbout', () => {
  it('keeps the zoom point fixed on screen', () => {
    const v = { scale: 0.5, tx: 10, ty: 20 }
    const z = zoomAbout(v, 2, 300, 200, 0.05, 40)
    // The image point under (300, 200) before and after is the same.
    expect((300 - z.tx) / z.scale).toBeCloseTo((300 - v.tx) / v.scale)
    expect((200 - z.ty) / z.scale).toBeCloseTo((200 - v.ty) / v.scale)
    expect(z.scale).toBe(1)
  })

  it('clamps the scale', () => {
    expect(zoomAbout({ scale: 30, tx: 0, ty: 0 }, 2, 0, 0, 0.05, 40).scale).toBe(40)
  })

  it('leaves a never-fitted (scale 0 / NaN) view alone instead of producing NaN offsets', () => {
    const zero = { scale: 0, tx: 0, ty: 0 }
    expect(zoomAbout(zero, 1.15, 100, 100, 0.05, 40)).toBe(zero)
    const nan = { scale: NaN, tx: 0, ty: 0 }
    expect(zoomAbout(nan, 1.15, 100, 100, 0.05, 40)).toBe(nan)
  })
})

describe('screenToImage on a preview', () => {
  const frame = imageFrame({
    naturalWidth: PREVIEW.w,
    naturalHeight: PREVIEW.h,
    metaWidth: NATIVE.w,
    metaHeight: NATIVE.h,
    lowRes: true,
  })
  const view = fitView(1140, 855, frame.width, frame.height) // scale 0.1, no offset

  it('returns NATIVE pixels, not preview pixels', () => {
    // The centre of the viewport is the centre of the image in native px — on the
    // old naturalWidth mapping this came out ~22× too small (≈256, 192).
    const p = screenToImage(570, 427.5, view, frame)
    expect(p.px).toBeCloseTo(NATIVE.w / 2)
    expect(p.py).toBeCloseTo(NATIVE.h / 2)
    // Bottom-right corner.
    const q = screenToImage(1140, 855, view, frame)
    expect(q.px).toBeCloseTo(NATIVE.w)
    expect(q.py).toBeCloseTo(NATIVE.h)
  })

  it('clamps to the native frame', () => {
    expect(screenToImage(-50, 5000, view, frame)).toEqual({ px: 0, py: NATIVE.h })
  })

  it('round-trips with the native → screen draw mapping', () => {
    const px = 1234.5,
      py = 6789.25
    const sx = px * view.scale + view.tx,
      sy = py * view.scale + view.ty
    const p = screenToImage(sx, sy, view, frame)
    expect(p.px).toBeCloseTo(px)
    expect(p.py).toBeCloseTo(py)
  })

  it('refuses while the native size is unknown', () => {
    const inexact = imageFrame({ naturalWidth: PREVIEW.w, naturalHeight: PREVIEW.h, lowRes: true })
    expect(screenToImage(10, 10, { scale: 1, tx: 0, ty: 0 }, inexact)).toBeNull()
    expect(screenToImage(10, 10, { scale: 1, tx: 0, ty: 0 }, null)).toBeNull()
  })

  it('bitmapPixel finds the preview pixel holding a native pixel', () => {
    expect(bitmapPixel(NATIVE.w / 2, NATIVE.h / 2, frame)).toEqual({ x: 256, y: 192 })
    expect(bitmapPixel(NATIVE.w, NATIVE.h, frame)).toEqual({ x: PREVIEW.w - 1, y: PREVIEW.h - 1 })
    const full = imageFrame({ naturalWidth: 100, naturalHeight: 50 })
    expect(bitmapPixel(42.7, 13.2, full)).toEqual({ x: 42, y: 13 })
  })
})
