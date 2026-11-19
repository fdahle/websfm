import { describe, expect, it } from 'vitest'
import { nearestTurn, turnCentred, turnPosition, turnRaster, unturnPoint } from './turn.js'

// A 5 × 3 raster whose value names its pixel: 10·y + x, two channels (value, value + 100).
const W = 5,
  H = 3
const raster = () => {
  const d = new Float32Array(W * H * 2)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      d[(y * W + x) * 2] = 10 * y + x
      d[(y * W + x) * 2 + 1] = 100 + 10 * y + x
    }
  return d
}

describe('turn', () => {
  it('turns a position as the raster turns: the pixel centre lands on the turned pixel centre', () => {
    for (const turn of [0, 90, 180, 270]) {
      const [tw, th] = turn % 180 ? [H, W] : [W, H]
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; x++) {
          const [ux, uy] = unturnPoint(x, y, W, H, turn)
          expect(turnPosition(ux + 0.5, uy + 0.5, W, H, turn)).toEqual([x + 0.5, y + 0.5])
        }
    }
  })
  it('turns a position back with the opposite turn, and four quarter turns are none', () => {
    const p = [1.25, 2.75]
    for (const turn of [0, 90, 180, 270]) {
      const [tw, th] = turn % 180 ? [H, W] : [W, H]
      const q = turnPosition(...p, W, H, turn)
      expect(turnPosition(...q, tw, th, (360 - turn) % 360)).toEqual(p)
    }
    let q = p,
      w = W,
      h = H
    for (let k = 0; k < 4; k++) {
      q = turnPosition(...q, w, h, 90)
      ;[w, h] = [h, w]
    }
    expect(q).toEqual(p)
  })

  it('turns a raster so every turned pixel shows the pixel unturnPoint names', () => {
    for (const turn of [0, 90, 180, 270]) {
      const { data, width, height } = turnRaster(raster(), W, H, turn, 2)
      expect([width, height]).toEqual(turn % 180 ? [H, W] : [W, H])
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const [ux, uy] = unturnPoint(x, y, W, H, turn)
          expect(data[(y * width + x) * 2]).toBe(10 * uy + ux)
          expect(data[(y * width + x) * 2 + 1]).toBe(100 + 10 * uy + ux)
        }
    }
  })

  it('turns clockwise: the top-left corner goes to the top-right at 90°', () => {
    const { data, width } = turnRaster(raster(), W, H, 90, 2)
    expect(data[(0 * width + (width - 1)) * 2]).toBe(0) // unturned (0, 0)
  })

  it('agrees with turnCentred about the image centre', () => {
    for (const turn of [0, 90, 180, 270]) {
      const [tw, th] = turn % 180 ? [H, W] : [W, H]
      for (const [x, y] of [
        [0, 0],
        [4, 1],
        [2, 2],
      ]) {
        // The turned pixel that shows (x, y), found by search, against the rotation.
        let found = null
        for (let ty = 0; ty < th && !found; ty++)
          for (let tx = 0; tx < tw; tx++) {
            const [ux, uy] = unturnPoint(tx, ty, W, H, turn)
            if (ux === x && uy === y) found = [tx, ty]
          }
        const [u, v] = turnCentred(x - (W - 1) / 2, y - (H - 1) / 2, turn)
        expect(u + (tw - 1) / 2).toBeCloseTo(found[0], 9)
        expect(v + (th - 1) / 2).toBeCloseTo(found[1], 9)
      }
    }
  })

  it('rounds any angle to the nearest quarter turn', () => {
    expect([0, 44, 46, 176, 212, -90, 359, 310].map(nearestTurn)).toEqual([0, 0, 90, 180, 180, 270, 0, 270])
  })
})
