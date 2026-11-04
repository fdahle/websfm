import { markRaw, ref } from 'vue'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { makeNameResolver } from '../core/io/nameMatch.js'
import { keypointsFromPointMatches, readFeatureFile, validMatchIndices } from '../core/io/featureText.js'
import { KP_STRIDE, Keypoints } from '../core/features/keypoints.js'
import { inlierSpread } from '../core/features/verify.js'
import { evaluatePairAcceptance } from '../core/features/pairGate.js'
import { MATCH_DEFAULTS } from '../core/defaults.user.js'
import { MATCH_TUNING } from '../core/tuning.js'
import { applyTuningOverrides } from '../stores/tuningOverrides.js'
import { POOL_SIZE, verifyPointPairs } from '../workers/computeClient.js'
import { mapConcurrent } from '../utils/concurrency.js'
import { pluralize } from '../core/textFormat.js'
import { useLog } from './useLog.js'

// Import ▸ Keypoints & Matches: text and CSV files from another detector or matcher
// (core/io/featureText.js says which layouts). Reading the files only fills the
// session the dialog shows; the stores change in commit, with the user's choices.
//
// Index matches refer to the keypoints imported with them, or, for an image that has
// none in the files, to the keypoints it already has. Matched points by position bring
// their own keypoints, added after any the files give for that image. Matches are then
// verified as Match Features verifies its own (F-RANSAC and the same acceptance gate,
// at the default thresholds), on every worker, unless the user says they already are.
//
// One import at a time, shared: the ribbon opens it, the dialog shows it, Escape closes it.
const session = ref(null)
let generation = 0

export function useFeatureImport() {
  const imagesStore = useImagesStore()
  const matchesStore = useMatchesStore()
  const { log } = useLog()

  async function openFeatureImport(fileList) {
    const files = [...(fileList || [])]
    if (!files.length) return
    const gen = ++generation
    session.value = {
      status: 'inspecting',
      sourceName: files.length === 1 ? files[0].name : `${files.length} files`,
    }
    const warnings = []
    const fileKeypoints = new Map() // file name of the image → { x, y, scale, angle }
    const indexPairs = []
    const pointPairs = []
    for (const file of files) {
      try {
        const r = readFeatureFile(await file.text(), file.name)
        if (r.kind === 'keypoints')
          for (const im of r.images) {
            if (fileKeypoints.has(im.name)) warnings.push(`${im.name}: keypoints in two files; the later file is used`)
            fileKeypoints.set(im.name, im)
          }
        else if (r.kind === 'matches') indexPairs.push(...r.pairs)
        else pointPairs.push(...r.pairs)
      } catch (err) {
        warnings.push(`${file.name} left out: ${err?.message ?? err}`)
      }
    }
    if (gen !== generation) return

    const resolve = makeNameResolver(imagesStore.images, { key: 'uuid' })
    const byUuid = new Map(imagesStore.images.map((img) => [img.uuid, img]))
    const unmatched = new Set()
    const uuidOf = (name) => {
      const uuid = resolve(name)
      if (!uuid) unmatched.add(name)
      return uuid
    }

    // Keypoints per project image: the files' own, then the matched points' (appended).
    const keypoints = new Map() // uuid → { x: number[], y, scale, angle, fromFile }
    for (const [name, im] of fileKeypoints) {
      const uuid = uuidOf(name)
      if (uuid) keypoints.set(uuid, { x: [...im.x], y: [...im.y], scale: im.scale, angle: im.angle })
    }
    const pairs = []
    if (pointPairs.length) {
      const derived = keypointsFromPointMatches(pointPairs)
      const offset = new Map()
      for (const [name, kp] of derived.keypoints) {
        const uuid = uuidOf(name)
        if (!uuid) continue
        const have = keypoints.get(uuid)
        if (!have) keypoints.set(uuid, { x: [...kp.x], y: [...kp.y], scale: null, angle: null })
        else {
          offset.set(name, have.x.length)
          have.x.push(...kp.x)
          have.y.push(...kp.y)
          // Matched points have no scale or orientation.
          if (have.scale) have.scale = Float32Array.from([...have.scale, ...new Float32Array(kp.x.length)])
          if (have.angle) have.angle = Float32Array.from([...have.angle, ...new Float32Array(kp.x.length)])
        }
      }
      for (const p of derived.pairs) {
        const oa = offset.get(p.a) ?? 0,
          ob = offset.get(p.b) ?? 0
        const idx = p.idx
        if (oa || ob)
          for (let k = 0; k < idx.length; k += 2) {
            idx[k] += oa
            idx[k + 1] += ob
          }
        pairs.push({ a: p.a, b: p.b, idx, own: true })
      }
    }
    for (const p of indexPairs) pairs.push({ ...p, own: false })

    // Resolve and check every pair against the keypoints its indices refer to.
    const resolved = []
    let invalid = 0,
      noKeypoints = 0,
      onExisting = 0
    for (const p of pairs) {
      const uuidA = uuidOf(p.a),
        uuidB = uuidOf(p.b)
      if (!uuidA || !uuidB || uuidA === uuidB) continue
      const count = (uuid) =>
        keypoints.get(uuid)?.x.length ?? (byUuid.get(uuid)?.kpStatus === 'done' ? byUuid.get(uuid).kpCount : 0)
      const countA = count(uuidA),
        countB = count(uuidB)
      if (!countA || !countB) {
        noKeypoints++
        continue
      }
      const usesExisting = !keypoints.has(uuidA) || !keypoints.has(uuidB)
      if (usesExisting) onExisting++
      const v = validMatchIndices(p.idx, countA, countB)
      invalid += v.invalid
      if (v.idx.length) resolved.push({ uuidA, uuidB, idx: markRaw(v.idx), usesExisting })
    }
    if (unmatched.size) {
      const names = [...unmatched]
      warnings.push(
        `${pluralize(names.length, 'image name')} not in this project: ${names.slice(0, 3).join(', ')}` +
          (names.length > 3 ? ` and ${names.length - 3} more` : ''),
      )
    }
    if (invalid)
      warnings.push(`${pluralize(invalid, 'match', 'matches')} with an index past the image's keypoints left out`)
    if (noKeypoints)
      warnings.push(
        `${pluralize(noKeypoints, 'pair')} left out: an image has no keypoints, in the files or in the project`,
      )

    const replaced = [...keypoints.keys()].filter((uuid) => byUuid.get(uuid)?.kpStatus === 'done').length
    session.value = {
      status: !keypoints.size && !resolved.length ? 'error' : 'ready',
      error:
        !keypoints.size && !resolved.length ? 'No keypoints or matches for images in this project were found' : null,
      sourceName: session.value.sourceName,
      keypoints: markRaw(keypoints),
      pairs: markRaw(resolved),
      counts: {
        keypointImages: keypoints.size,
        keypoints: [...keypoints.values()].reduce((n, k) => n + k.x.length, 0),
        replaced,
        pairs: resolved.length,
        matches: resolved.reduce((n, p) => n + p.idx.length / 2, 0),
        onExisting,
        ownPairs: resolved.filter((p) => !p.usesExisting).length,
      },
      warnings,
      progress: null,
    }
  }

  function closeFeatureImport() {
    generation++
    session.value = null
  }

  const packKeypoints = (k) => {
    const n = k.x.length
    const data = new Float32Array(KP_STRIDE * n)
    for (let i = 0; i < n; i++) {
      const o = KP_STRIDE * i
      data[o] = k.x[i]
      data[o + 1] = k.y[i]
      data[o + 4] = k.scale?.[i] ?? 0
    }
    return new Keypoints(data, null)
  }

  // F-RANSAC and the acceptance gate of Match Features, per pair, over the worker pool.
  // → the entries importMatches takes (inliers only), and what became of the rest.
  async function verify(pairs, kpsOf, onProgress, label = 'Keypoints & Matches import') {
    const settings = applyTuningOverrides('match', { ...MATCH_DEFAULTS, ...MATCH_TUNING })
    const workers = Math.max(1, Math.min(POOL_SIZE, pairs.length))
    log(
      `${label}: verifying ${pluralize(pairs.length, 'pair')} on ${pluralize(workers, 'worker')} ` +
        `(${settings.verifier === 'magsac' ? 'MAGSAC++' : 'RANSAC'} ${settings.ransacThreshPx} px)`,
      'info',
      'Import',
    )
    let done = 0,
      rejected = 0,
      weak = 0
    const out = await mapConcurrent(pairs, workers, async (p) => {
      const [kpsA, kpsB] = await Promise.all([kpsOf(p.uuidA), kpsOf(p.uuidB)])
      const n = p.idx.length / 2
      const ptsA = new Float32Array(2 * n),
        ptsB = new Float32Array(2 * n)
      const list = new Array(n)
      for (let i = 0; i < n; i++) {
        const ia = p.idx[2 * i],
          ib = p.idx[2 * i + 1]
        list[i] = { ia, ib }
        ptsA[2 * i] = kpsA.x(ia)
        ptsA[2 * i + 1] = kpsA.y(ia)
        ptsB[2 * i] = kpsB.x(ib)
        ptsB[2 * i + 1] = kpsB.y(ib)
      }
      const result =
        n >= 8 ? await verifyPointPairs(ptsA, ptsB, { ...settings, hSkipBelow: settings.minMatches }) : null
      const spread = result ? inlierSpread(kpsA, kpsB, list, result.inlierMask) : null
      const verdict = evaluatePairAcceptance({ result, rawCount: n, spread, settings })
      onProgress?.(++done, pairs.length)
      if (!(verdict.accept || verdict.weak)) {
        rejected++
        return null
      }
      if (verdict.weak) weak++
      const keep = []
      for (let i = 0; i < n; i++) if (result.inlierMask[i] > 0.5) keep.push(list[i].ia, list[i].ib)
      return {
        uuidA: p.uuidA,
        uuidB: p.uuidB,
        matches: Uint32Array.from(keep),
        F: result.F,
        rawCount: n,
        inlierCount: result.inlierCount,
        verified: true,
        weak: verdict.weak,
      }
    })
    return { entries: out.filter(Boolean), rejected, weak, workers }
  }

  /**
   * Keypoints and index matches into the stores: the dialog's Import, and the Metashape
   * project import. set { keypoints: Map uuid → { x, y, scale }, pairs: [{ uuidA, uuidB,
   * idx }] }; options { keypoints, matches, verify, replaceMatches, source, label,
   * onProgress }. Throws on a store error.
   */
  async function importFeatureSet(set, options) {
    const source = options.source ?? 'text'
    const label = options.label ?? 'Keypoints & Matches import'
    const byUuid = new Map(imagesStore.images.map((img) => [img.uuid, img]))
    const imported = new Map()
    if (options.keypoints && set.keypoints.size) {
      const entries = []
      for (const [uuid, k] of set.keypoints) {
        const kps = packKeypoints(k)
        imported.set(uuid, kps)
        entries.push({ uuid, keypoints: kps, descriptors: null, detector: 'external', source })
      }
      await imagesStore.importFeatures(entries, { invalidateMatches: true })
    }
    if (options.matches && set.pairs.length) {
      // Without the set's keypoints, only pairs on keypoints the project has can go in.
      const pairs = options.keypoints
        ? set.pairs
        : set.pairs.filter((p) => !set.keypoints.has(p.uuidA) && !set.keypoints.has(p.uuidB))
      const kpsOf = async (uuid) => imported.get(uuid) ?? (await imagesStore.readKeypoints(byUuid.get(uuid)))
      let entries, summary
      if (options.verify) {
        const r = await verify(pairs, kpsOf, options.onProgress, label)
        entries = r.entries.map((e) => ({ ...e, source }))
        summary =
          `${pluralize(entries.length, 'pair')} verified` +
          (r.weak ? ` (${r.weak} weak, kept to register cameras only)` : '') +
          (r.rejected ? `, ${pluralize(r.rejected, 'pair')} rejected by the geometric check` : '')
      } else {
        entries = pairs.map((p) => ({
          uuidA: p.uuidA,
          uuidB: p.uuidB,
          matches: p.idx,
          rawCount: p.idx.length / 2,
          inlierCount: p.idx.length / 2,
          verified: true,
          weak: false,
          source,
        }))
        summary = `${pluralize(entries.length, 'pair')} taken as already verified`
      }
      await matchesStore.importMatches(entries, { replace: !!options.replaceMatches })
      log(`${label}: ${summary}`, 'success', 'Import')
    }
  }

  /** options { keypoints, matches, verify, replaceMatches } */
  async function commitFeatureImport(options) {
    const s = session.value
    if (!s || s.status !== 'ready') return
    s.status = 'importing'
    s.error = null
    try {
      await importFeatureSet(s, {
        ...options,
        onProgress: (done, total) => {
          s.progress = { done, total }
        },
      })
      closeFeatureImport()
    } catch (err) {
      s.status = 'ready'
      s.error = err?.message ?? String(err)
      log(`Keypoints & Matches import failed: ${s.error}`, 'error', 'Import')
    }
  }

  return { featureImportSession: session, openFeatureImport, closeFeatureImport, commitFeatureImport, importFeatureSet }
}
