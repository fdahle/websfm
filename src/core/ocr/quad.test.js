import { describe, it, expect } from 'vitest'
import {
  convexHull,
  minAreaRect,
  rectCorners,
  orderQuad,
  unclipRect,
  insideConvex,
  growPolygon,
  polyBounds,
} from './quad.js'

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

describe('convexHull', () => {
  it('drops interior and collinear points', () => {
    const pts = [
      [0, 0],
      [2, 0],
      [4, 0],
      [4, 3],
      [0, 3],
      [2, 1],
      [1, 2],
    ]
    const hull = convexHull(pts)
    expect(hull).toHaveLength(4)
    for (const corner of [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ])
      expect(hull).toContainEqual(corner)
  })
})

describe('minAreaRect', () => {
  it('finds an axis-aligned rectangle exactly', () => {
    const pts = []
    for (let x = 10; x <= 30; x++) for (let y = 5; y <= 9; y++) pts.push([x, y])
    const r = minAreaRect(pts)
    expect(close(r.cx, 20)).toBe(true)
    expect(close(r.cy, 7)).toBe(true)
    expect([r.w, r.h].sort((a, b) => a - b)).toEqual([4, 20])
  })

  it('finds a rotated rectangle by its own sides, not the axes', () => {
    // Corners of a 40×10 rectangle turned 30°: its bounding box is far larger.
    const a = Math.PI / 6
    const ux = Math.cos(a),
      uy = Math.sin(a)
    const corners = rectCorners({ cx: 100, cy: 50, w: 40, h: 10, ux, uy })
    const r = minAreaRect(corners)
    expect(r.w * r.h).toBeCloseTo(400, 6)
    expect(Math.max(r.w, r.h)).toBeCloseTo(40, 6)
    expect(r.cx).toBeCloseTo(100, 6)
    expect(r.cy).toBeCloseTo(50, 6)
  })

  it('gives a zero-width rectangle for collinear points', () => {
    const r = minAreaRect([
      [0, 0],
      [5, 0],
      [10, 0],
    ])
    expect(Math.min(r.w, r.h)).toBe(0)
    expect(Math.max(r.w, r.h)).toBe(10)
  })
})

describe('orderQuad', () => {
  it('orders corners top-left, top-right, bottom-right, bottom-left', () => {
    const q = orderQuad([
      [10, 10],
      [0, 0],
      [0, 10],
      [10, 0],
    ])
    expect(q).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
  })
})

describe('unclipRect', () => {
  it('grows a rectangle by area × ratio / perimeter on each side', () => {
    const r = unclipRect({ cx: 0, cy: 0, w: 30, h: 10, ux: 1, uy: 0 }, 1.5)
    const d = (300 * 1.5) / 80
    expect(r.w).toBeCloseTo(30 + 2 * d, 12)
    expect(r.h).toBeCloseTo(10 + 2 * d, 12)
  })
})

describe('insideConvex', () => {
  const sq = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ]
  it('tells inside, edge and outside apart in either winding', () => {
    expect(insideConvex(sq, 5, 5)).toBe(true)
    expect(insideConvex(sq, 10, 5)).toBe(true)
    expect(insideConvex(sq, 11, 5)).toBe(false)
    expect(insideConvex([...sq].reverse(), 5, 5)).toBe(true)
    expect(insideConvex([...sq].reverse(), -1, 5)).toBe(false)
  })
})

describe('growPolygon', () => {
  it('moves every side of a rectangle out by d, in either winding', () => {
    const sq = [
      [0, 0],
      [10, 0],
      [10, 4],
      [0, 4],
    ]
    for (const poly of [sq, [...sq].reverse()]) {
      const [x0, y0, x1, y1] = polyBounds(growPolygon(poly, 3))
      expect([x0, y0, x1, y1].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-3, -3, 13, 7])
    }
  })

  it('grows a turned rectangle along its own sides', () => {
    const a = Math.PI / 4
    const corners = rectCorners({ cx: 0, cy: 0, w: 20, h: 6, ux: Math.cos(a), uy: Math.sin(a) })
    const r = minAreaRect(growPolygon(corners, 2))
    expect(Math.max(r.w, r.h)).toBeCloseTo(24, 9)
    expect(Math.min(r.w, r.h)).toBeCloseTo(10, 9)
  })
})
