// The smallest Hamming distance of a tag family (tagDetect.js): between any two of its
// codes in any of the four rotations, and between a code and its own turns (a marker
// that reads the same turned would have no defined corner order). A detector may correct
// fewer than half of it. Codes are Numbers of up to 36 bits; bit i (most significant
// first) is the cell (BIT_X[i], BIT_Y[i]) of the WIDTH_AT_BORDER box.

const popcount = (v) => {
  let n = 0
  while (v) {
    n += v & 1
    v >>>= 1
  }
  return n
}
// Hamming distance of two codes of up to 36 bits held as Numbers.
export const hamming = (a, b) =>
  popcount((a % 2 ** 18) ^ (b % 2 ** 18)) + popcount(Math.floor(a / 2 ** 18) ^ Math.floor(b / 2 ** 18))

// `code` read with the tag turned a quarter: bit i takes the bit of the cell a quarter
// turn of (BIT_X[i], BIT_Y[i]) lands on, as tagDetect.js decode reads a rotation.
export function rotateCode(fam, code) {
  const W = fam.WIDTH_AT_BORDER,
    n = fam.NBITS
  const at = new Map()
  for (let i = 0; i < n; i++) at.set(fam.BIT_Y[i] * W + fam.BIT_X[i], i)
  let out = 0
  for (let i = 0; i < n; i++) {
    const x = W - 1 - fam.BIT_Y[i],
      y = fam.BIT_X[i]
    const j = at.get(y * W + x)
    out = out * 2 + (Math.floor(code / 2 ** (n - 1 - j)) % 2)
  }
  return out
}

export function familyDistance(fam) {
  const rots = fam.CODES.map((c) => {
    const r1 = rotateCode(fam, c),
      r2 = rotateCode(fam, r1)
    return [c, r1, r2, rotateCode(fam, r2)]
  })
  let best = Infinity
  for (let a = 0; a < rots.length; a++) {
    for (let k = 1; k < 4; k++) best = Math.min(best, hamming(rots[a][0], rots[a][k]))
    for (let b = a + 1; b < rots.length; b++)
      for (let k = 0; k < 4; k++) best = Math.min(best, hamming(rots[a][0], rots[b][k]))
  }
  return best
}
