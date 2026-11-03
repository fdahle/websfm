import { describe, it, expect } from 'vitest'
import { arucoFamily, ARUCO_DICTIONARIES } from './aruco.js'
import { familyDistance, rotateCode } from './familyDistance.js'
import * as TAG36H11 from './tag36h11.js'
import { detectTags } from '../tagDetect.js'

// Render a marker of `fam` (its black box mapped onto the square at (cx, cy), half side
// `half`, turned by `angle`) by 4 × 4 supersampling, on mid-grey with a white margin.
function renderMarker(fam, id, { cx = 100, cy = 100, half = 48, angle = 0.3, flips = [], w = 200, h = 200 }) {
  const W = fam.WIDTH_AT_BORDER,
    T = W + 2
  const cells = Array.from({ length: T }, (_, y) =>
    Array.from({ length: T }, (_, x) => (x === 0 || y === 0 || x === T - 1 || y === T - 1 ? 1 : 0)),
  )
  const code = fam.CODES[id]
  for (let i = 0; i < fam.NBITS; i++) {
    const bit = Math.floor(code / 2 ** (fam.NBITS - 1 - i)) % 2
    cells[fam.BIT_Y[i] + 1][fam.BIT_X[i] + 1] = flips.includes(i) ? 1 - bit : bit
  }
  const c = Math.cos(angle),
    s = Math.sin(angle)
  let seed = 5
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const dx = x - 0.5 + (i + 0.5) / 4 - cx,
            dy = y - 0.5 + (j + 0.5) / 4 - cy
          // Into box units: −1..1 over the black box, then cells.
          const u = (c * dx + s * dy) / half,
            t = (-s * dx + c * dy) / half
          const gx = Math.floor(((u + 1) / 2) * W) + 1,
            gy = Math.floor(((t + 1) / 2) * W) + 1
          v += gx >= 0 && gy >= 0 && gx < T && gy < T ? (cells[gy][gx] ? 230 : 20) : 120
        }
      data[y * w + x] = v / 16 + 3 * rand()
    }
  return { data, width: w, height: h }
}

describe('ArUco dictionaries', () => {
  it("read OpenCV's marker 0 of DICT_4X4_50, white cells as 1", () => {
    const fam = arucoFamily('4x4_50')
    expect(fam.CODES[0]).toBe(0xb532)
    expect(fam.WIDTH_AT_BORDER).toBe(6)
    const rows = [0, 1, 2, 3].map((r) => (fam.CODES[0] >> (12 - 4 * r)) & 15)
    expect(rows).toEqual([0b1011, 0b0101, 0b0011, 0b0010])
  })

  it('turn a code as OpenCV lists its rotations', () => {
    const fam = arucoFamily('4x4_50')
    let c = fam.CODES[0]
    const turns = new Set()
    for (let k = 0; k < 4; k++) {
      turns.add(c)
      c = rotateCode(fam, c)
    }
    expect(turns).toEqual(new Set([181 * 256 + 50, 235 * 256 + 72, 76 * 256 + 173, 18 * 256 + 215]))
  })

  it('tell their codes apart by as many bits as OpenCV corrects for', () => {
    // OpenCV's maxCorrectionBits: 4x4_50 1, 5x5_100 3, 6x6_250 5, 4x4_1000 0.
    expect(arucoFamily('4x4_50').MIN_HAMMING).toBe(4)
    expect(arucoFamily('5x5_100').MIN_HAMMING).toBe(7)
    expect(arucoFamily('6x6_250').MIN_HAMMING).toBe(11)
    expect(arucoFamily('4x4_1000').MIN_HAMMING).toBe(2)
    expect(familyDistance(TAG36H11)).toBe(11)
    expect(ARUCO_DICTIONARIES).toContain('6x6_1000')
    expect(() => arucoFamily('7x7_50')).toThrow()
  })
})

describe('detecting ArUco markers', () => {
  for (const [dict, id] of [
    ['4x4_50', 7],
    ['5x5_100', 42],
    ['6x6_250', 123],
  ]) {
    it(`finds ${dict} marker ${id}, its centre within a third of a pixel`, () => {
      const fam = arucoFamily(dict)
      const tags = detectTags(renderMarker(fam, id, { cx: 101.3, cy: 98.6 }), { family: fam })
      expect(tags.map((t) => t.id)).toEqual([id])
      expect(tags[0].hamming).toBe(0)
      expect(Math.hypot(tags[0].center.x - 101.3, tags[0].center.y - 98.6)).toBeLessThan(0.34)
    })
  }

  it('corrects a wrong bit where the dictionary allows, and reads no other family', () => {
    const fam = arucoFamily('6x6_250')
    const img = renderMarker(fam, 200, { flips: [9] })
    const [tag] = detectTags(img, { family: fam })
    expect(tag).toMatchObject({ id: 200, hamming: 1 })
    expect(detectTags(img, { family: TAG36H11 })).toEqual([])
    expect(detectTags(img, { family: arucoFamily('4x4_50') })).toEqual([])
    // 4x4_50 tells codes apart by 4: a wrong bit is corrected, never two.
    const small = arucoFamily('4x4_50')
    expect(detectTags(renderMarker(small, 3, { flips: [5] }), { family: small })[0]).toMatchObject({
      id: 3,
      hamming: 1,
    })
    expect(detectTags(renderMarker(small, 3, { flips: [5, 10] }), { family: small }).map((t) => t.id)).not.toContain(3)
  })
})
