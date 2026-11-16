import { describe, it, expect } from 'vitest'
import { ctcDecode, cropQuad, readingOrders, recInput, recognizeText, REC_HEIGHT, REC_MIN_WIDTH } from './recognize.js'
import { EN_DICT } from './dictEn.js'

const CLASSES = EN_DICT.length + 2
const cls = (ch) => (ch === ' ' ? CLASSES - 1 : EN_DICT.indexOf(ch) + 1)

// Step probabilities that put `p` on each listed class (0 = blank).
function steps(classes, p = 0.9) {
  const out = new Float32Array(classes.length * CLASSES)
  classes.forEach((c, t) => {
    out.fill((1 - p) / (CLASSES - 1), t * CLASSES, (t + 1) * CLASSES)
    out[t * CLASSES + c] = p
  })
  return out
}

describe('the character table', () => {
  it('holds 436 single characters: the model has blank + 436 + space classes', () => {
    expect(EN_DICT).toHaveLength(436)
    expect(EN_DICT.every((c) => [...c].length === 1)).toBe(true)
    expect(EN_DICT.slice(0, 10).join('')).toBe('0123456789')
  })
})

describe('ctcDecode', () => {
  it('merges repeats, drops blanks and keeps a doubled letter split by a blank', () => {
    const seq = [cls('F'), cls('F'), 0, cls('3'), cls('1'), 0, cls(' '), cls('L'), 0, cls('L')]
    const { text, score } = ctcDecode(steps(seq), seq.length, CLASSES)
    expect(text).toBe('F31 LL')
    expect(score).toBeCloseTo(0.9, 6)
  })

  it('scores an empty read 0', () => {
    expect(ctcDecode(steps([0, 0, 0]), 3, CLASSES)).toEqual({ text: '', score: 0 })
  })

  it('reads a line at an offset in a batch', () => {
    const a = steps([cls('A')]),
      b = steps([cls('7')], 0.6)
    const both = new Float32Array(2 * CLASSES)
    both.set(a, 0)
    both.set(b, CLASSES)
    expect(ctcDecode(both, 1, CLASSES, EN_DICT, CLASSES)).toEqual({ text: '7', score: expect.closeTo(0.6, 6) })
  })
})

// A raster whose value tells where each pixel is: dark left half, light right half,
// with a dark top band, to check which way a crop comes out.
function raster(w, h, f) {
  const g = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y)
  return g
}

describe('cropQuad', () => {
  it('cuts a wide box out upright at 48 px high, keeping its aspect', () => {
    const g = raster(200, 100, (x) => (x < 100 ? 0 : 255))
    const quad = [
      [0, 40],
      [200, 40],
      [200, 60],
      [0, 60],
    ]
    const c = cropQuad(g, 200, 100, quad)
    expect(c.h).toBe(REC_HEIGHT)
    expect(c.w).toBe(480)
    expect(c.data[10 * c.w + 5]).toBe(0)
    expect(c.data[10 * c.w + c.w - 5]).toBe(255)
  })

  it('turns a tall box so the first edge of its reading order is the top', () => {
    // A tall box, dark along its left side: read top to bottom (angle 270), the left
    // side of the box is the bottom of the line; read bottom to top (90), the top.
    const g = raster(40, 200, (x) => (x < 20 ? 0 : 255))
    const quad = [
      [0, 0],
      [40, 0],
      [40, 200],
      [0, 200],
    ]
    const orders = readingOrders(quad)
    expect(orders.map((o) => o.angle)).toEqual([270, 90])
    const down = cropQuad(g, 40, 200, orders[0].quad)
    const up = cropQuad(g, 40, 200, orders[1].quad)
    expect(down.w).toBe(240)
    expect(down.data[2 * down.w + 100]).toBe(255)
    expect(down.data[45 * down.w + 100]).toBe(0)
    expect(up.data[2 * up.w + 100]).toBe(0)
    expect(up.data[45 * up.w + 100]).toBe(255)
  })

  it('reads a wide box as it lies and upside down', () => {
    const quad = [
      [0, 0],
      [100, 0],
      [100, 20],
      [0, 20],
    ]
    expect(readingOrders(quad).map((o) => o.angle)).toEqual([0, 180])
  })
})

describe('recInput', () => {
  it('pads every crop to the widest (at least the model minimum) with mid grey', () => {
    const a = { data: new Uint8Array(48 * 10).fill(255), w: 10, h: 48 }
    const b = { data: new Uint8Array(48 * 400).fill(0), w: 400, h: 48 }
    const { data, dims } = recInput([a, b])
    expect(dims).toEqual([2, 3, 48, 400])
    const plane = 48 * 400
    expect(data[0]).toBeCloseTo(1, 6)
    expect(data[20]).toBe(0)
    expect(data[3 * plane]).toBeCloseTo(-1, 6)
    expect(recInput([a]).dims[3]).toBe(REC_MIN_WIDTH)
  })
})

describe('recognizeText', () => {
  it('keeps the reading order with the higher score', async () => {
    // A wide box, light on its left half: read as it lies the "network" sees light
    // first and says "AB" surely; upside down it sees dark first and is unsure.
    const g = raster(100, 20, (x) => (x < 50 ? 255 : 0))
    const quad = [
      [0, 0],
      [100, 0],
      [100, 20],
      [0, 20],
    ]
    const run = async (data, dims) => {
      const [n, , , W] = dims
      const out = new Float32Array(n * 2 * CLASSES)
      for (let k = 0; k < n; k++) {
        const light = data[k * 3 * 48 * W + 10 * W + 2] > 0
        const seq = light ? [cls('A'), cls('B')] : [cls('Z'), cls('Z')]
        out.set(steps(seq, light ? 0.95 : 0.4), k * 2 * CLASSES)
      }
      return { data: out, dims: [n, 2, CLASSES] }
    }
    const [read] = await recognizeText(g, 100, 20, [quad], run)
    expect(read).toEqual({ text: 'AB', score: expect.closeTo(0.95, 6), angle: 0 })
  })
})
