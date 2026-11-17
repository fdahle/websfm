import { describe, it, expect } from 'vitest'
import { bandProfile, frameEdge, detectFrameMargins, consistentMargins, nativeFrameMargins } from './maskFrame.js'

// A synthetic scan: bright scanner bed `bed` px, then a dark frame to `frame` px on each
// side (per side), then a photograph of mid-grey texture.
function scan(w, h, { bed = 0, frame = { top: 30, right: 20, bottom: 40, left: 25 }, photo = 170, dark = 20 } = {}) {
  const g = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const d = Math.min(x, y, w - 1 - x, h - 1 - y)
      const inFrame = y < frame.top || x >= w - frame.right || y >= h - frame.bottom || x < frame.left
      g[y * w + x] = d < bed ? 240 : inFrame ? dark : photo + (((x * 7 + y * 13) % 31) - 15)
    }
  return g
}

describe('frameEdge', () => {
  it('finds where the photograph begins after a dark frame', () => {
    const p = Float32Array.from([20, 20, 20, 20, 20, 170, 170, 170, 170, 170, ...new Array(90).fill(170)])
    expect(frameEdge(p, false).at).toBe(5)
  })

  it('walks past a bright scanner bed and a thin bright line inside the frame', () => {
    const p = new Float32Array(200).fill(170)
    p.set([240, 240, 20, 20, 20, 200, 20, 20, 20, 20])
    expect(frameEdge(p, false).at).toBe(10)
  })

  it('finds no frame where the edge is no darker than the photograph', () => {
    expect(frameEdge(new Float32Array(200).fill(150), false)).toEqual({ at: 0, contrast: 0 })
  })

  it('takes dark ground well inside the edge for no frame', () => {
    const p = new Float32Array(200).fill(170)
    for (let k = 20; k < 40; k++) p[k] = 30
    expect(frameEdge(p, false).at).toBe(0)
  })

  it('walks in from the far end', () => {
    const p = new Float32Array(100).fill(170)
    for (let k = 92; k < 100; k++) p[k] = 10
    expect(frameEdge(p, true).at).toBe(8)
  })
})

describe('detectFrameMargins', () => {
  it('finds each side of a synthetic scan, inside a scanner bed', () => {
    const w = 400,
      h = 300
    const r = detectFrameMargins(scan(w, h, { bed: 6 }), w, h)
    expect([r.top, r.right, r.bottom, r.left]).toEqual([30, 20, 40, 25])
    expect(r.contrast.left).toBeGreaterThan(0.5)
  })

  it('is not fooled by a bright data card on the frame (the median across the scan)', () => {
    const w = 400,
      h = 300
    const g = scan(w, h)
    // A white card on the right frame over a third of the profiled band.
    for (let y = 120; y < 180; y++) for (let x = w - 20; x < w; x++) g[y * w + x] = 255
    expect(detectFrameMargins(g, w, h).right).toBe(20)
  })

  it('finds no frame on a photograph without one', () => {
    const w = 300,
      h = 200
    const g = new Uint8Array(w * h)
    for (let i = 0; i < g.length; i++) g[i] = 90 + ((i * 37) % 120)
    const r = detectFrameMargins(g, w, h)
    expect([r.top, r.right, r.bottom, r.left]).toEqual([0, 0, 0, 0])
  })

  it('profiles the middle of the other axis', () => {
    const w = 10,
      h = 10
    const g = new Uint8Array(w * h).fill(100)
    for (let x = 0; x < w; x++) g[x] = 0 // the first row dark at its ends only would not matter
    expect(bandProfile(g, w, h, 'y')[0]).toBe(0)
    expect(bandProfile(g, w, h, 'x')[0]).toBe(100)
  })
})

describe('consistentMargins', () => {
  it('replaces a side far from its group median, keeps the rest', () => {
    const list = [
      { top: 43, right: 36, bottom: 11, left: 72 },
      { top: 43, right: 38, bottom: 12, left: 145 },
      { top: 44, right: 40, bottom: 12, left: 7 },
      { top: 43, right: 106, bottom: 12, left: 70 },
    ]
    const out = consistentMargins(list, 1024, 958)
    expect(out.map((m) => m.left)).toEqual([72, 72, 72, 70])
    expect(out[3].right).toBe(40)
    expect(out[0].replaced).toEqual([])
    expect(out[1].replaced).toEqual(['left'])
  })

  it('leaves groups of fewer than three alone', () => {
    const list = [
      { top: 1, right: 1, bottom: 1, left: 1 },
      { top: 90, right: 1, bottom: 1, left: 1 },
    ]
    expect(consistentMargins(list, 100, 100).map((m) => m.top)).toEqual([1, 90])
  })
})

describe('nativeFrameMargins', () => {
  it('scales to native px per axis, adds the inset and keeps a missing side at 0', () => {
    const m = nativeFrameMargins({ top: 43, right: 0, bottom: 11.2, left: 72 }, 0.1, 0.2, 10000, 9000, 0.005)
    expect(m).toEqual({ top: 265, right: 0, bottom: 106, left: 770 })
  })
})
