// Pairing ▸ Similar images: choose the pairs to match by image retrieval
// (core/features/retrieval.js). Three passes over the worker pool:
//   1. a codebook learned from descriptors sampled evenly over the photos (one worker:
//      ~4 s, the sample is small);
//   2. each photo's VLAD vector (the pool: one photo per call, its descriptors loaded
//      from storage once and transferred);
//   3. each photo's k most similar photos (the pool: blocks of rows over one shared copy
//      of the vectors).
// Photos are grouped by detector and descriptor length (their descriptors cannot be
// compared, nor matched, across groups); each group gets its own codebook.
import * as opfs from '../../utils/opfs.js'
import { POOL_SIZE, retrievalCodebook, retrievalEncode, retrievalTopK } from '../../workers/computeClient.js'
import { retrievalPairs, sampleImageRows, samplesPerImage } from '../../core/features/retrieval.js'
import { descriptorsAsFloat, toMatchSpace } from '../../core/features/siftDescriptors.js'
import { sharedArray } from '../../core/bigArray.js'
import { RETRIEVAL_TUNING } from '../../core/tuning.js'
import { pluralize } from '../../core/textFormat.js'

/** One photo's descriptors in the space matching uses (RootSIFT for SIFT), as floats, or null. */
export function descriptorLoader({ projectId, persisting }) {
  return async (img) => {
    const d = persisting
      ? ((await opfs.loadDescriptors(projectId, img.uuid)) ?? img.descriptors ?? null)
      : (img.descriptors ?? null)
    // Stored bytes widen into a new array; VLAD's codebook and residuals are float maths.
    return descriptorsAsFloat(toMatchSpace(d, img, img.descDim ?? 128))
  }
}

// Run `fn(item, i)` over `items` with at most `limit` in flight; stops early on cancel.
async function pooled(items, limit, fn, isCancelled) {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !isCancelled()) {
      const i = next++
      await fn(items[i], i)
    }
  })
  await Promise.all(lanes)
}

/**
 * The pairs of `images` (records with uuid, descDim, detector) retrieval keeps for
 * `neighbors` per image, as [imgA, imgB] in the images' order. A group no larger than
 * neighbors + 1 is paired exhaustively (every photo is among every other's k anyway).
 *
 * @returns {Promise<{ pairs: Array<[object, object]>, groups: number, seconds: number, cancelled?: boolean }>}
 */
export async function selectRetrievalPairs(
  images,
  { neighbors, extra: extraPicks = 0, loadDescriptors, log, isCancelled = () => false, onProgress, avoidWorker } = {},
) {
  const t0 = performance.now()
  const k = Math.max(1, Math.floor(neighbors))
  // Spread-out picks on top of the k (core/features/retrieval.js diverseSimilar).
  const extra = Math.max(0, Math.floor(extraPicks || 0))
  const width = k + extra
  const groups = new Map()
  for (const img of images) {
    const key = `${img.detector ?? 'sift'}/${img.descDim ?? 128}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(img)
  }
  const order = new Map(images.map((img, i) => [img.uuid, i]))
  const pairs = []
  const total = images.length * 2 // samples + vectors, one tick per photo each
  let ticks = 0
  const tick = () => onProgress?.(++ticks / total)
  const workers = Math.max(1, Math.min(POOL_SIZE, images.length))

  for (const [key, group] of groups) {
    if (isCancelled()) return { pairs: [], groups: groups.size, seconds: 0, cancelled: true }
    const n = group.length
    if (n <= width + 1) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([group[i], group[j]])
      ticks += 2 * n
      continue
    }
    const dim = group[0].descDim ?? 128

    // 1. Codebook from an even sample of every photo.
    const tStart = performance.now()
    const per = samplesPerImage(n)
    const parts = new Array(n)
    await pooled(
      group,
      workers,
      async (img, i) => {
        const d = await loadDescriptors(img)
        parts[i] = d ? sampleImageRows(d, dim, per, RETRIEVAL_TUNING.seed, i) : new Float32Array(0)
        tick()
      },
      isCancelled,
    )
    if (isCancelled()) return { pairs: [], groups: groups.size, seconds: 0, cancelled: true }
    const tSampled = performance.now()
    const sampleLen = parts.reduce((s, p) => s + p.length, 0)
    const samples = new Float32Array(sampleLen)
    let off = 0
    for (const p of parts) {
      samples.set(p, off)
      off += p.length
    }
    const { codebook, words, iterations } = await retrievalCodebook(
      samples,
      dim,
      { words: RETRIEVAL_TUNING.words, iterations: RETRIEVAL_TUNING.kmeansIterations, seed: RETRIEVAL_TUNING.seed },
      { avoidWorker },
    )
    const tCodebook = performance.now()

    // 2. One vector per photo, spread over the pool.
    const len = words * dim
    const vectors = sharedArray(Float32Array, n * len)
    await pooled(
      group,
      workers,
      async (img, i) => {
        const d = await loadDescriptors(img)
        // A copy to transfer: the loader may hand back the image's live in-memory buffer.
        const v = await retrievalEncode(d ? d.slice() : new Float32Array(0), dim, codebook, words, { avoidWorker })
        vectors.set(v, i * len)
        tick()
      },
      isCancelled,
    )
    if (isCancelled()) return { pairs: [], groups: groups.size, seconds: 0, cancelled: true }
    const tEncode = performance.now()

    // 3. Top-k over blocks of rows.
    const index = new Int32Array(n * width)
    const blocks = []
    const rowsPer = Math.ceil(n / workers)
    for (let from = 0; from < n; from += rowsPer) blocks.push([from, Math.min(n, from + rowsPer)])
    await Promise.all(
      blocks.map(async ([from, to]) => {
        const r = await retrievalTopK(vectors, len, k, from, to, {
          avoidWorker,
          extra,
          pool: RETRIEVAL_TUNING.diversePool,
        })
        index.set(r.index, from * width)
      }),
    )
    for (const [i, j] of retrievalPairs(index, width)) pairs.push([group[i], group[j]])
    const tTop = performance.now()
    log?.(
      `Similar images (${key}): ${sampleLen / dim} descriptors sampled in ${((tSampled - tStart) / 1000).toFixed(1)} s, ` +
        `codebook of ${words} words in ${((tCodebook - tSampled) / 1000).toFixed(1)} s (${iterations} iterations), ` +
        `${pluralize(n, 'image')} encoded in ${((tEncode - tCodebook) / 1000).toFixed(1)} s and ranked in ` +
        `${((tTop - tEncode) / 1000).toFixed(1)} s on ${pluralize(workers, 'worker')}`,
      'info',
      'Matching',
    )
  }
  // The images' order inside each pair, as the other strategies give them.
  for (const p of pairs) if (order.get(p[0].uuid) > order.get(p[1].uuid)) p.reverse()
  return { pairs, groups: groups.size, seconds: (performance.now() - t0) / 1000 }
}
