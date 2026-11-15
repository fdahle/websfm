// Image retrieval for pair selection: which photos look alike, before any pair is
// matched. Each photo's local descriptors are summarised in one VLAD vector (Jégou et al.
// 2010): every descriptor is assigned to its nearest word of a small codebook, and the
// residuals (descriptor − word) are summed per word. The vector is normalised as in
// Arandjelović & Zisserman 2013: each word's block to unit length (intra-normalisation,
// against bursty texture that would let one repeated pattern dominate), then a signed
// square root and a global L2. Two photos are similar when their vectors' dot product is
// high, and each photo is paired with its k most similar ones.
//
// The codebook is learned on the project's own descriptors (k-means++ then Lloyd), so it
// works for every detector (SIFT in RootSIFT, SuperPoint, DISK, ALIKED) with no trained
// vocabulary to download. Pure: plain typed arrays in and out; the store loads the
// descriptors and spreads the encoding over the worker pool.

import { RETRIEVAL_TUNING } from '../tuning.js'

// Deterministic 32-bit generator (mulberry32): the same project gives the same codebook,
// and so the same pairs, on every run.
export function seededRandom(seed = 1) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Photo `i`'s codebook sample: sampleRows with a generator of its own, seeded from the
 * run's seed and its index. Photos are loaded in parallel and finish in any order; one
 * generator shared between them gave each photo the offset of whichever draw it came to,
 * so the codebook, and with it the pairs, changed from run to run.
 *
 * @param {Float32Array} desc
 * @param {number} dim
 * @param {number} n
 * @param {number} seed
 * @param {number} i
 */
export function sampleImageRows(desc, dim, n, seed, i) {
  return sampleRows(desc, dim, n, seededRandom((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0))
}

/**
 * `n` rows of an N×dim descriptor buffer, spread evenly over it (every (N/n)-th row from a
 * seeded offset), copied. All rows when N ≤ n.
 *
 * @param {Float32Array} desc  N×dim, row-major
 * @param {number} dim
 * @param {number} n
 * @param {() => number} [rand]
 * @returns {Float32Array}  m×dim, m = min(n, N)
 */
export function sampleRows(desc, dim, n, rand = Math.random) {
  const rows = Math.floor(desc.length / dim)
  const m = Math.min(Math.max(0, Math.floor(n)), rows)
  const out = new Float32Array(m * dim)
  if (m === 0) return out
  const step = rows / m
  const offset = rand() * step
  for (let i = 0; i < m; i++) {
    const r = Math.min(rows - 1, Math.floor(offset + i * step))
    out.set(desc.subarray(r * dim, (r + 1) * dim), i * dim)
  }
  return out
}

// Squared distance between row `i` of `a` and row `j` of `b`.
function dist2(a, i, b, j, dim) {
  let s = 0
  const oa = i * dim,
    ob = j * dim
  for (let d = 0; d < dim; d++) {
    const t = a[oa + d] - b[ob + d]
    s += t * t
  }
  return s
}

/**
 * Index of the nearest codebook word to row `i` of `x`.
 *
 * Minimises |c|² − 2 x·c (|x|² is the same for every word), with |c|² precomputed.
 */
function nearestWord(x, i, codebook, norms, words, dim) {
  const ox = i * dim
  let best = 0,
    bestD = Infinity
  for (let w = 0; w < words; w++) {
    const oc = w * dim
    let dot = 0
    for (let d = 0; d < dim; d++) dot += x[ox + d] * codebook[oc + d]
    const v = norms[w] - 2 * dot
    if (v < bestD) {
      bestD = v
      best = w
    }
  }
  return best
}

function wordNorms(codebook, words, dim) {
  const norms = new Float64Array(words)
  for (let w = 0; w < words; w++) {
    let s = 0
    for (let d = 0; d < dim; d++) s += codebook[w * dim + d] ** 2
    norms[w] = s
  }
  return norms
}

/**
 * A codebook of `words` centres by k-means (k-means++ seeding, then Lloyd iterations
 * until no assignment changes or `iterations` run out). A word left empty takes the
 * sample farthest from its own word, so every word stays in use.
 *
 * @param {Float32Array} samples  m×dim
 * @param {number} dim
 * @param {{ words?: number, iterations?: number, seed?: number }} [opts]
 * @returns {{ codebook: Float32Array, words: number, iterations: number }}
 */
export function trainCodebook(samples, dim, opts = {}) {
  const m = Math.floor(samples.length / dim)
  const words = Math.max(1, Math.min(opts.words ?? RETRIEVAL_TUNING.words, m))
  const maxIter = opts.iterations ?? RETRIEVAL_TUNING.kmeansIterations
  const rand = seededRandom(opts.seed ?? 1)
  const codebook = new Float32Array(words * dim)
  if (m === 0) return { codebook, words: 0, iterations: 0 }

  // k-means++: each next word drawn with probability ∝ squared distance to the nearest
  // word so far.
  const d2 = new Float64Array(m)
  let first = Math.min(m - 1, Math.floor(rand() * m))
  codebook.set(samples.subarray(first * dim, (first + 1) * dim), 0)
  for (let i = 0; i < m; i++) d2[i] = dist2(samples, i, codebook, 0, dim)
  for (let w = 1; w < words; w++) {
    let total = 0
    for (let i = 0; i < m; i++) total += d2[i]
    let pick = m - 1
    if (total > 0) {
      let r = rand() * total
      for (let i = 0; i < m; i++) {
        r -= d2[i]
        if (r <= 0) {
          pick = i
          break
        }
      }
    } else pick = Math.min(m - 1, Math.floor(rand() * m))
    codebook.set(samples.subarray(pick * dim, (pick + 1) * dim), w * dim)
    for (let i = 0; i < m; i++) {
      const d = dist2(samples, i, codebook, w, dim)
      if (d < d2[i]) d2[i] = d
    }
  }

  const assign = new Int32Array(m).fill(-1)
  const sums = new Float64Array(words * dim)
  const counts = new Int32Array(words)
  let iterations = 0
  for (; iterations < maxIter; iterations++) {
    const norms = wordNorms(codebook, words, dim)
    let changed = 0
    sums.fill(0)
    counts.fill(0)
    for (let i = 0; i < m; i++) {
      const w = nearestWord(samples, i, codebook, norms, words, dim)
      if (w !== assign[i]) {
        assign[i] = w
        changed++
      }
      counts[w]++
      const os = i * dim,
        ow = w * dim
      for (let d = 0; d < dim; d++) sums[ow + d] += samples[os + d]
    }
    if (changed === 0) break
    for (let w = 0; w < words; w++) {
      if (counts[w] > 0) {
        for (let d = 0; d < dim; d++) codebook[w * dim + d] = sums[w * dim + d] / counts[w]
        continue
      }
      // Empty word: move it onto the sample farthest from its own word.
      let far = 0,
        farD = -1
      for (let i = 0; i < m; i++) {
        const d = dist2(samples, i, codebook, assign[i], dim)
        if (d > farD) {
          farD = d
          far = i
        }
      }
      codebook.set(samples.subarray(far * dim, (far + 1) * dim), w * dim)
    }
  }
  return { codebook, words, iterations }
}

/**
 * One photo's VLAD vector: residuals to the nearest word summed per word, each word's
 * block L2-normalised, then signed square root and global L2 normalisation. A photo with
 * no descriptors gives the zero vector (similar to nothing).
 *
 * @param {Float32Array} desc  N×dim
 * @param {number} dim
 * @param {Float32Array} codebook  words×dim
 * @param {number} words
 * @returns {Float32Array}  words·dim
 */
export function vladEncode(desc, dim, codebook, words) {
  const n = Math.floor(desc.length / dim)
  const acc = new Float64Array(words * dim)
  const norms = wordNorms(codebook, words, dim)
  for (let i = 0; i < n; i++) {
    const w = nearestWord(desc, i, codebook, norms, words, dim)
    const od = i * dim,
      ow = w * dim
    for (let d = 0; d < dim; d++) acc[ow + d] += desc[od + d] - codebook[ow + d]
  }
  const out = new Float32Array(words * dim)
  let total = 0
  for (let w = 0; w < words; w++) {
    const ow = w * dim
    let s = 0
    for (let d = 0; d < dim; d++) s += acc[ow + d] * acc[ow + d]
    if (!(s > 0)) continue
    const inv = 1 / Math.sqrt(s)
    for (let d = 0; d < dim; d++) {
      const v = acc[ow + d] * inv
      const r = Math.sign(v) * Math.sqrt(Math.abs(v))
      out[ow + d] = r
      total += r * r
    }
  }
  if (total > 0) {
    const inv = 1 / Math.sqrt(total)
    for (let j = 0; j < out.length; j++) out[j] *= inv
  }
  return out
}

/**
 * For rows [from, to) of the N×len vector buffer, the `k` most similar other rows by dot
 * product, best first. Ties go to the lower index, so the result is deterministic.
 *
 * @param {Float32Array} vectors  N×len
 * @param {number} len
 * @param {number} k
 * @param {number} [from]
 * @param {number} [to]
 * @returns {{ index: Int32Array, score: Float32Array, k: number }}  (to−from)×k, −1 / NaN past N−1
 */
export function topKSimilar(vectors, len, k, from = 0, to = Math.floor(vectors.length / len)) {
  const n = Math.floor(vectors.length / len)
  const rows = Math.max(0, to - from)
  const index = new Int32Array(rows * k).fill(-1)
  const score = new Float32Array(rows * k).fill(NaN)
  const bestI = new Int32Array(k)
  const bestS = new Float64Array(k)
  for (let r = 0; r < rows; r++) {
    const i = from + r
    let have = 0
    const oi = i * len
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const oj = j * len
      let s = 0
      for (let d = 0; d < len; d++) s += vectors[oi + d] * vectors[oj + d]
      if (have === k && !(s > bestS[k - 1])) continue
      // Insert into the sorted top-k (descending score; ties keep the earlier index).
      let p = have < k ? have++ : k - 1
      while (p > 0 && bestS[p - 1] < s) {
        bestS[p] = bestS[p - 1]
        bestI[p] = bestI[p - 1]
        p--
      }
      bestS[p] = s
      bestI[p] = j
    }
    for (let q = 0; q < have; q++) {
      index[r * k + q] = bestI[q]
      score[r * k + q] = bestS[q]
    }
  }
  return { index, score, k }
}

function dot(vectors, len, a, b) {
  const oa = a * len,
    ob = b * len
  let s = 0
  for (let d = 0; d < len; d++) s += vectors[oa + d] * vectors[ob + d]
  return s
}

/** How many spread-out picks Similar images adds to `k` (RETRIEVAL_TUNING.spreadOut). */
export function spreadExtras(k) {
  return Math.max(0, Math.round(k * RETRIEVAL_TUNING.spreadOut))
}

/**
 * For rows [from, to): the `k` most similar rows as topKSimilar gives them, then up to
 * `extra` more that spread over the scene. Down the ranking past the first k (at most
 * `pool` deep), a candidate is taken unless it looks more like an extra already taken
 * than like the row's own photo, so the extras do not crowd along one strip or orbit:
 * after one photo of a parallel strip, its strip-mates are skipped and the next extra
 * comes from elsewhere. (The neighbour-selection rule of graph-based search, Malkov &
 * Yashunin 2020, applied to the extras only: the first k flank the photo on all sides and would rule out
 * nearly everything.) A photo mid-strip spends its first two extras further along its
 * own strip, one each way, before any reaches a parallel one. A row ends in −1 where
 * fewer qualify.
 *
 * @param {Float32Array} vectors  N×len
 * @param {number} len
 * @param {number} k
 * @param {number} extra
 * @param {number} pool  candidates ranked per row (≥ k)
 * @param {number} [from]
 * @param {number} [to]
 * @returns {{ index: Int32Array, k: number }}  (to−from)×(k+extra), −1 past the picks
 */
export function diverseSimilar(vectors, len, k, extra, pool, from = 0, to = Math.floor(vectors.length / len)) {
  const width = k + extra
  const depth = Math.max(k, pool)
  const ranked = topKSimilar(vectors, len, depth, from, to)
  const rows = Math.max(0, to - from)
  const index = new Int32Array(rows * width).fill(-1)
  const taken = new Int32Array(extra)
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < k; q++) index[r * width + q] = ranked.index[r * depth + q]
    let have = 0
    for (let q = k; q < depth && have < extra; q++) {
      const c = ranked.index[r * depth + q]
      if (c < 0) break
      const toQuery = ranked.score[r * depth + q]
      let covered = false
      for (let t = 0; t < have && !covered; t++) covered = dot(vectors, len, c, taken[t]) > toQuery
      if (covered) continue
      taken[have] = c
      index[r * width + k + have++] = c
    }
  }
  return { index, k: width }
}

/**
 * The pairs retrieval keeps: each photo with its `k` most similar, in either direction
 * (a pair is kept when either photo has the other among its k), as sorted index pairs.
 *
 * @param {Int32Array} index  N×k from topKSimilar over all rows
 * @param {number} k
 * @returns {Array<[number, number]>}  i < j, sorted
 */
export function retrievalPairs(index, k) {
  const n = Math.floor(index.length / k)
  const keys = new Set()
  const out = []
  for (let i = 0; i < n; i++) {
    for (let q = 0; q < k; q++) {
      const j = index[i * k + q]
      if (j < 0 || j === i) continue
      const a = Math.min(i, j),
        b = Math.max(i, j)
      const key = a * n + b
      if (keys.has(key)) continue
      keys.add(key)
      out.push([a, b])
    }
  }
  return out.sort((p, q) => p[0] - q[0] || p[1] - q[1])
}

/**
 * How many descriptors to take from each photo for the codebook: an even share of
 * `RETRIEVAL_TUNING.trainSamples`, at least `minPerImage`, never more than it holds.
 *
 * @param {number} images
 * @returns {number}
 */
export function samplesPerImage(images) {
  const { trainSamples, minPerImage } = RETRIEVAL_TUNING
  return Math.max(minPerImage, Math.ceil(trainSamples / Math.max(1, images)))
}
