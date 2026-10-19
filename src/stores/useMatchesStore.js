import { shallowRef, triggerRef, computed, markRaw } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'
import {
  matchDescriptors, matchLightGlue, verifyPointPairs, POOL_SIZE,
  matchDescriptorsGpu, matchGpuBegin, matchGpuEnd, GPU_MATCH_WORKER,
} from '../workers/computeClient.js'
import { createGpuMatchRun } from './matching/gpuMatchRun.js'
import { createDescriptorCache } from './matching/descriptorCache.js'
import {
  packMatchDocument, packMatchFlags, unpackMatchIndex, toMatchArray, MATCH_HEAVY_KEYS, MATCH_INDEX_KEYS,
  isPersistedMatchEntry, planMatchReads, matchByteRange,
} from '../core/features/matchStorage.js'
import { createByteLru } from '../utils/byteLru.js'
import { useLog } from '../composables/useLog.js'
import { preselectPairs, positionsForProximity, preselectByFootprintOverlap } from '../core/features/preselect.js'
import { sequentialPairs } from '../core/features/sequentialPairs.js'
import { inlierSpread, packMatchedPoints } from '../core/features/verify.js'
import { makeVerifyMapper, mapVerifyPoints, expandInlierMask } from '../core/features/verifyFrame.js'
import { distortionOf } from '../core/sfm/distortion.js'
import { resolveK } from '../core/sfm/reconstruction.js'
import { evaluatePairAcceptance } from '../core/features/pairGate.js'
import { filterStationaryMatches, stationaryTolPx } from '../core/features/stationary.js'
import { pickSpreadIndices, sliceDescriptorRows, resolveSubsetGateSize, SUBSET_GATE_SIZE_DEFAULTS } from '../core/features/subsetGate.js'
import { siblingCanonicalMap, canonicalizeMatches } from '../core/features/orientationSiblings.js'
import { toMatchSpace } from '../core/features/siftDescriptors.js'
import { swapMatchRoles, transposeF } from '../core/sfm/matchCodec.js'
import { learnedDetector, lightGlueModelFor } from '../core/features/learnedDetectors.js'
import { MATCH_DEFAULTS } from '../core/defaults.user.js'
import { MATCH_TUNING, RESIDENT_TUNING } from '../core/tuning.js'
import { applyTuningOverrides } from './tuningOverrides.js'
import { pairScaleContext, buildScaleContext, describeScaleContext, resolveScaledPx } from '../core/scaleContext.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useFootprintsStore } from './useFootprintsStore.js'
import { useModelsStore } from './useModelsStore.js'
import { useImagesStore } from './useImagesStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { nounFor, pluralize } from '../core/textFormat.js'

const EMPTY_MATCHES = new Uint32Array(0)

// Original image dimensions (px) in the same space as keypoint x,y — needed by
// LightGlue's coord normalization. Prefer EXIF meta; else recover from a keypoint
// (x = nx·natW, where nx is the detect-normalized coord stored alongside).
function imageDims(img, kps) {
  const w = img.meta?.width, h = img.meta?.height
  if (w && h) return [w, h]
  for (let i = 0; i < (kps?.length ?? 0); i++) {
    if (kps.nx(i) > 0 && kps.ny(i) > 0) return [Math.round(kps.x(i) / kps.nx(i)), Math.round(kps.y(i) / kps.ny(i))]
  }
  return [1, 1]
}

// Project-scoped store: pairwise feature matches. Reads persistence flags from the
// projects store; restore/clear run through the project-store registry.
export const useMatchesStore = registerProjectStore(defineStore('matches', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const posesStore = usePosesStore()

  // pairId → { idA, idB, rawCount, inlierCount, F, nMatches, src, status, enabled,
  //            weak }. The entry is the pair's SUMMARY; its matches (a flat Uint32Array
  //            [ia0, ib0, ia1, ib1, …], read as pairs via core/sfm/matchCodec.js) are
  //            not on it. They live in the committed match document (`src` = { file,
  //            off }: the matches column as a File and the pair's element offset, null
  //            until saved) and, when something has asked for them, in the byte-bounded
  //            `matchCache` below (TODO ▸ SC-2). Gate on `nMatches`, never on whether
  //            the matches are resident. `enabled: false` is a user override that
  //            excludes an otherwise-verified pair from reconstruction (obviously-wrong
  //            matches) — reversible.
  // shallowRef + in-place mutation + triggerRef (NOT a whole-Map copy per write):
  // this is what makes concurrent matchPair() calls safe — copying the Map on every
  // write races (one writer's snapshot clobbers another's set). See P2 in HANDOVER.
  const matchStore = shallowRef(new Map())
  const touch = () => triggerRef(matchStore)

  // ── A pair's matches, on demand ──────────────────────────────────────────────
  // pairId → { entry, matches }. A fresh result (matchPair, import) is
  // PINNED until a document commit holds it, and forever in a project
  // that cannot persist; a copy read back from the document is clean and evictable.
  // `entry` is kept with it because a re-match replaces the entry under the same id.
  //   ensurePairMatches(pid) — cached (the match preview)
  //   readPairMatches(pid)   — read through, not cached
  //   streamPairMatches(entries, onPair) — a bulk pass in the caller's order, one read
  //     per run of adjacent pairs (SfM input, exports, fingerprints)
  const matchCache = createByteLru({ budgetBytes: RESIDENT_TUNING.matchCacheMiB * 2 ** 20 })
  const matchLoads = new Map() // pairId → { entry, promise }
  const pairIdOf = (e) => `${e.idA}--${e.idB}` // entries keep idA < idB
  function holdMatches(pid, entry, matches) {
    entry.nMatches = matches.length >>> 1
    if (!entry.nMatches) { matchCache.delete(pid); return }
    matchCache.set(pid, { entry, matches: markRaw(matches) }, matches.byteLength, { pinned: true })
  }
  function residentFor(pid, entry, touchIt = true) {
    const v = touchIt ? matchCache.get(pid) : matchCache.peek(pid)
    return v && v.entry === entry ? v.matches : null
  }
  /** The pair's matches if they are in memory now, else null (never reads). */
  function residentPairMatches(pid) {
    const entry = matchStore.value.get(pid)
    return entry ? residentFor(pid, entry) : null
  }
  // The committed generation's matches column as a File (restore / adoptCommit), and
  // a re-fetch of it by name from the CURRENT project root. A File is a handle to one
  // file: moving the project between browser storage and a folder deletes (or leaves
  // behind) the one every entry points at, and the copy in the new root has the same
  // name. Shared, so concurrent failed reads rebind once.
  let matchesFile = null, rebinding = null
  function rebindMatchesFile() {
    rebinding ??= (async () => {
      const c = committed
      if (!c?.files?.matches || c.projectId !== projects.currentProjectId) return false
      let file
      try { file = await opfs.loadMatchesFile(c.projectId, c.files.matches) } catch { return false }
      const old = matchesFile
      for (const e of matchStore.value.values()) if (e.src?.file === old) e.src = { file, off: e.src.off }
      matchesFile = file
      return true
    })().finally(() => { rebinding = null })
    return rebinding
  }
  // One pair from the committed document. A save commits a new generation and then
  // collects the old one, so a read that loses that race retries once on the entry's
  // new location; a read whose file went away otherwise (a storage move) rebinds.
  async function readFromDocument(entry) {
    for (let attempt = 0; ; attempt++) {
      const src = entry.src
      if (!src) return null
      try {
        const [start, end] = matchByteRange(src.off, entry.nMatches)
        return new Uint32Array(await src.file.slice(start, end).arrayBuffer())
      } catch (err) {
        if (attempt > 0) throw err
        if (saving) await saving.catch(() => {})
        if (entry.src === src && !(await rebindMatchesFile())) throw err
      }
    }
  }
  function unavailable(pid) {
    return new Error(`Matches of pair ${pid} are neither in memory nor in the saved match document — re-run matching`)
  }
  async function loadPair(pid, cache) {
    const entry = matchStore.value.get(pid)
    if (!entry || !(entry.nMatches > 0)) return EMPTY_MATCHES
    const hit = residentFor(pid, entry, cache)
    if (hit) return hit
    const pending = matchLoads.get(pid)
    if (pending?.entry === entry) return pending.promise
    if (!entry.src) throw unavailable(pid)
    const promise = readFromDocument(entry).then((m) => {
      if (!m) throw unavailable(pid)
      if (cache && matchStore.value.get(pid) === entry && !residentFor(pid, entry, false)) {
        matchCache.set(pid, { entry, matches: markRaw(m) }, m.byteLength)
      }
      return m
    }).finally(() => { if (matchLoads.get(pid)?.promise === promise) matchLoads.delete(pid) })
    matchLoads.set(pid, { entry, promise })
    return promise
  }
  /** The pair's matches (flat Uint32Array), read and kept (LRU) on first use. */
  const ensurePairMatches = (pid) => loadPair(pid, true)
  /** The pair's matches for a one-off read: resident, else straight from the document. */
  const readPairMatches = (pid) => loadPair(pid, false)
  /**
   * Visit `entries` in the given order with their matches: `await onPair(entry,
   * matches)`. `matches` may be a VIEW into a shared read window, valid only during the
   * call — copy it to keep it. Adjacent pairs in the document share one read
   * (core/features/matchStorage.js planMatchReads), so a pass in document order (the
   * store's own order after a reopen) costs a few large reads, not one per pair.
   */
  async function streamPairMatches(entries, onPair) {
    const windowBytes = RESIDENT_TUNING.matchReadWindowMiB * 2 ** 20
    let run = []
    const flush = async () => {
      if (!run.length) return
      const items = run.map((e) => ({ file: e.src.file, off: e.src.off, n: e.nMatches, entry: e }))
      run = []
      for (const w of planMatchReads(items, { windowBytes })) {
        let buf = null
        try { buf = new Uint32Array(await w.file.slice(w.start, w.end).arrayBuffer()) } catch { buf = null }
        for (const it of w.items) {
          if (buf) {
            const s = it.off - w.start / 4
            await onPair(it.entry, buf.subarray(s, s + 2 * it.n))
          } else {
            const m = await readFromDocument(it.entry) // the generation moved under us
            if (!m) throw unavailable(pairIdOf(it.entry))
            await onPair(it.entry, m)
          }
        }
      }
    }
    for (const e of entries) {
      const n = e.nMatches ?? 0
      const pid = pairIdOf(e)
      const hit = n > 0 ? residentFor(pid, e, false) : EMPTY_MATCHES
      if (hit) { await flush(); await onPair(e, hit); continue }
      if (!e.src) { await flush(); throw unavailable(pid) }
      run.push(e)
    }
    await flush()
  }
  const matchCacheStats = () => matchCache.stats()
  // SIFT orientation-sibling maps (core/features/orientationSiblings.js), keyed by the
  // keypoint array itself: re-detection replaces the array, so an entry can never go
  // stale, and a dropped array takes its map with it.
  const siblingCanon = new WeakMap()
  const canonFor = (kps) => {
    if (!kps) return null
    if (!siblingCanon.has(kps)) siblingCanon.set(kps, siblingCanonicalMap(kps))
    return siblingCanon.get(kps)
  }
  // matchPair's per-pair updates are THROTTLED to ≤10 Hz. Every trigger re-runs each
  // computed that walks the whole Map (App.vue `matchStats`/`matchSummaries`,
  // `usableMatchCount`) and re-renders their components, so 3–4 synchronous triggers
  // per pair made a run O(pairs²) on the main thread — on the 8128-pair SB run the
  // per-pair pace slowed from ~33 ms to ~90 ms as the Map filled. Entries are still
  // mutated in place immediately (getMatch/direct readers see them at once); only the
  // reactive notification is batched. matchAll flushes with `touch()` when it ends.
  let touchTimer = null
  const touchSoon = () => {
    if (touchTimer != null) return
    touchTimer = setTimeout(() => { touchTimer = null; touch() }, 100)
  }

  // The last completed matchAll run: its settings and its gate accounting (accepted /
  // weak / rejected / raw-skipped / subset-gated). Kept because the accounting is what
  // diagnoses a graph problem — "542 of 1280 sequential pairs gated" was the whole
  // 2026-07-25 bug, and no per-pair record shows it. Session-scoped on purpose: match
  // *pairs* persist per file, there is no run-level file, and a re-opened project has
  // no run to describe. Null until a run completes; a cancelled run leaves it alone.
  const matchRun = shallowRef(null)
  let restoreGeneration = 0

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // ── Persistence: the whole store is ONE packed document ────────────────────────
  // (core/features/matchStorage.js; one JSON file per pair before). Writes are
  // coalesced: one in flight, one trailing re-run that picks up whatever changed
  // meanwhile. `heavyVersion` bumps whenever a pair's matches/F/counts change, or a
  // pair is added or removed; a save at the version of the last commit (excluding a
  // pair) rewrites only the flags and reuses that commit's other buffers. Inside
  // matchAll (`batchDepth` > 0) pairs save periodically and once at the end; a lone
  // matchPair saves before it returns, so a superseded result never resurrects.
  let heavyVersion = 0
  let committed = null // { projectId, heavyVersion, meta, files }
  let saving = null, savingProjectId = null, saveAgain = false, saveTimer = null, batchDepth = 0
  const markHeavy = () => { heavyVersion++ }
  const persistable = isPersistedMatchEntry
  // A pair's matches for a full rewrite: the resident copy, else a slice of the
  // committed matches column (a Blob part — referenced, not read into memory).
  const documentPart = (pid, e) => {
    const hit = residentFor(pid, e, false)
    if (hit) return hit
    if (!e.src) throw unavailable(pid)
    const [start, end] = matchByteRange(e.src.off, e.nMatches)
    return e.src.file.slice(start, end)
  }
  // After a commit: every packed pair now lives at `off` of the new matches file, and
  // its resident copy (if any) is no longer the only one.
  async function adoptCommit(projectId, files, layout) {
    if (!layout || !files?.matches) return
    let file
    try { file = await opfs.loadMatchesFile(projectId, files.matches) } catch { return }
    matchesFile = file
    for (const { pairId, entry, off } of layout) {
      entry.src = { file, off }
      const v = matchCache.peek(pairId)
      if (v?.entry === entry) matchCache.unpin(pairId, v)
    }
  }
  function save() {
    if (!isPersisting()) return Promise.resolve()
    if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null }
    // One project per save: a rerun queued while a commit was in flight must not
    // pick up the next project's id (and its just-cleared store) after a switch. A
    // request from the next project waits for the old save, then runs its own.
    if (saving) {
      if (savingProjectId !== projects.currentProjectId) return saving.then(() => save())
      saveAgain = true
      return saving
    }
    const projectId = savingProjectId = projects.currentProjectId
    saving = (async () => {
      do {
        saveAgain = false
        if (projectId !== projects.currentProjectId) return
        const version = heavyVersion
        const reuse = committed?.projectId === projectId && committed.heavyVersion === version
        let meta, buffers, layout = null
        if (reuse) {
          meta = committed.meta
          buffers = { flags: packMatchFlags([...matchStore.value.values()].filter(persistable)) }
          for (const key of MATCH_HEAVY_KEYS) buffers[key] = { reuse: committed.files[key] }
        } else {
          const packed = packMatchDocument(matchStore.value, { matchesOf: documentPart })
          meta = packed.meta; layout = packed.layout
          // One Blob over resident arrays and slices of the previous generation: the
          // writer streams it, so a rewrite never holds every pair's matches at once.
          buffers = { ...packed.buffers, matches: new Blob(packed.matchParts) }
        }
        const res = await opfs.saveMatchDocument(projectId, meta, buffers)
        if (res?.stale) { committed = null; saveAgain = true; continue } // a reused file went: write in full
        if (res?.files) {
          committed = { projectId, heavyVersion: version, meta, files: res.files }
          await adoptCommit(projectId, res.files, layout)
        }
      } while (saveAgain)
    })().catch((err) => {
      log(`Matches: could not save — ${err?.message ?? err}`, 'warn', 'Matching')
    }).finally(() => { saving = null })
    return saving
  }
  // During a run: a save at most every 60 s, so a crash loses at most a minute of
  // matching without rewriting the document per pair.
  const schedulePersist = () => {
    if (saveTimer != null || !isPersisting()) return
    saveTimer = setTimeout(() => { saveTimer = null; save() }, 60_000)
  }
  // A flat Uint32Array of the putatives kept by `keep(i)` (all when omitted).
  const packPutatives = (raw, keep = null) => {
    let n = 0
    for (let i = 0; i < raw.length; i++) if (!keep || keep(i)) n++
    const out = new Uint32Array(2 * n)
    let o = 0
    for (let i = 0; i < raw.length; i++) if (!keep || keep(i)) { out[o++] = raw[i].ia; out[o++] = raw[i].ib }
    return out
  }

  function pairId(uuidA, uuidB) {
    return [uuidA, uuidB].sort().join('--')
  }

  function getMatch(uuidA, uuidB) {
    return matchStore.value.get(pairId(uuidA, uuidB)) ?? null
  }

  const verifiedPairs = computed(() => {
    let n = 0
    // Weak pairs (PnP bridges) don't count as verified geometry — they carry inliers but
    // failed the accept gate, so they're excluded here and from matchStats (reported apart).
    for (const v of matchStore.value.values()) if (v.status === 'done' && v.inlierCount > 0 && !v.weak) n++
    return n
  })
  const usableMatchCount = computed(() => {
    let n = 0
    for (const entry of matchStore.value.values()) {
      if (entry.status === 'done' && entry.enabled !== false && entry.inlierCount > 0) n++
    }
    return n
  })

  // `descCache` (optional): id → descriptors, shared across a matchAll run so each
  // image's descriptors are loaded from OPFS once instead of once per pair (an
  // image appears in N−1 pairs, so this turns O(N²) loads into O(N)).
  // `gpuRun` (optional): matchAll's WebGPU router (stores/matching/gpuMatchRun.js);
  // null ⇒ brute-force runs on the WASM pool exactly as before.
  // The pinhole-frame mapper an image's putatives are verified through, or null
  // (core/features/verifyFrame.js): only fisheye sensors get one. Same K and lens
  // as SfM ingest (resolveK + distortionOf), so the verified F is that frame's.
  function verifyMapperFor(img) {
    const sensor = img?.sensorId ? useSensorsStore().sensors.find((s) => s.id === img.sensorId) : null
    const dist = distortionOf(sensor)
    if (!dist?.fisheye || sensor.kind === 'film') return null
    return makeVerifyMapper(resolveK(img.meta, sensor), dist)
  }

  async function matchPairOnce(imgA, imgB, settings = {}, onDone, descCache = null, gpuRun = null) {
    // Resolve every knob from the single source of truth (defaults.user.js +
    // tuning.js), caller's `settings` winning, then the console's session overrides
    // (stores/tuningOverrides.js). Downstream reads `settings.X` directly.
    settings = applyTuningOverrides('match', { ...MATCH_DEFAULTS, ...MATCH_TUNING, ...settings })
    const [idA, idB] = [imgA.uuid, imgB.uuid].sort()
    const pid = pairId(idA, idB)

    // `matches` is this run's result; it reaches the entry (as `nMatches`) and the
    // match cache together, once the pair is done (holdMatches).
    let matches = EMPTY_MATCHES
    const entry = { idA, idB, rawCount: 0, inlierCount: 0, F: null, nMatches: 0, src: null, status: 'running', enabled: true, weak: false }
    entry.timing = { descriptorLoadMs: 0, descriptorBytes: 0, postMessageMs: 0, matchingMs: 0, verificationMs: 0, roundTripMs: 0 }
    const timing = stage => ({ onTiming: t => {
      entry.timing.postMessageMs += t.postMessageMs
      entry.timing[stage] += t.workerMs
      entry.timing.roundTripMs += t.roundTripMs
    } })
    // Brute-force NN: through the GPU router when this run has one (it validates,
    // caches descriptors by image id and falls back to WASM per pair), else WASM.
    // While a GPU run is active, WASM work keeps off the GPU-pinned worker.
    const avoidWorker = gpuRun ? GPU_MATCH_WORKER : undefined
    const bruteForce = (dA, dB, opts, kind, ids = [null, null]) => (gpuRun
      ? gpuRun.match(dA, dB, { ...opts, kind, idA: ids[0], idB: ids[1] }, timing('matchingMs'))
      : matchDescriptors(dA, dB, opts, timing('matchingMs')))
    // Supersedes the old result before any early exit (gated, failed or cancelled):
    // the next save writes this entry, never the old one — nor keeps its matches.
    matchStore.value.set(pid, entry)
    matchCache.delete(pid)
    markHeavy()
    // Trigger reactivity
    touchSoon()

    const projectId = projects.currentProjectId
    try {
      // STORAGE order is by uuid (idA/idB, the pair id, the packed [ia, ib] layout),
      // but uuids are random per project, so matching in that order made which image
      // plays "A" a coin flip per pair per project — and brute-force matching is
      // asymmetric (the ratio test runs from A's side, RANSAC samples in A's match
      // order): two fresh runs of the same images differed on ~8 % of pairs. Match in
      // NAME order instead (the files' names, stable across projects; uuid order on a
      // tie), and turn the result back into storage order below (`swapRoles`).
      const storeA = idA === imgA.uuid ? imgA : imgB
      const storeB = idA === imgA.uuid ? imgB : imgA
      const swapRoles = (storeB.name ?? '') < (storeA.name ?? '')
      // From here srcA/kpsA/descA are the MATCHING roles.
      const srcA = swapRoles ? storeB : storeA
      const srcB = swapRoles ? storeA : storeB
      // Keypoints load per image on demand (useImagesStore.ensureKeypoints; LRU-kept
      // across a run's pairs), ordered the same way as the ids.
      const images = useImagesStore()
      const [kpsA, kpsB] = await Promise.all([images.ensureKeypoints(srcA), images.ensureKeypoints(srcB)])
      if (!kpsA || !kpsB) {
        entry.status = 'error'
        log(`Match failed: keypoints missing for ${imgA.name} / ${imgB.name} — re-run feature detection`, 'error', 'Matching')
        touchSoon()
        return
      }

      // Cache the in-flight PROMISE (not just the result) so that concurrent pairs
      // sharing an image load its descriptors from OPFS exactly once.
      const loadDesc = (id, src) => {
        if (descCache?.has(id)) return descCache.get(id)
        // Persistent: OPFS is the copy (detection drops its in-memory one once
        // saved); the in-memory copy only survives a failed save.
        const p = (isPersisting()
          ? opfs.loadDescriptors(projectId, id).then((d) => d ?? src.descriptors ?? null)
          : Promise.resolve(src.descriptors ?? null))
          // SIFT matches in RootSIFT; legacy L2 detections convert here, once per run
          // (core/features/siftDescriptors.js). Never in place: `src.descriptors` is
          // the image's live copy.
          .then((d) => toMatchSpace(d, src, src.descDim ?? 128))
        descCache?.set(id, p)
        return p
      }
      const loadStarted = performance.now()
      const descA = await loadDesc(srcA.uuid, srcA)
      const descB = await loadDesc(srcB.uuid, srcB)

      entry.timing.descriptorLoadMs = performance.now() - loadStarted
      entry.timing.descriptorBytes = (descA?.byteLength ?? 0) + (descB?.byteLength ?? 0)
      if (!descA || !descB) {
        entry.status = 'error'
        const names = `${imgA.name} / ${imgB.name}`
        log(`Match failed: descriptors missing for ${names} — re-run feature detection`, 'error', 'Matching')
        touchSoon()
        return
      }

      const dimA = srcA.descDim ?? 128
      const dimB = srcB.descDim ?? 128
      if (dimA !== dimB || (srcA.detector ?? 'sift') !== (srcB.detector ?? 'sift')
          || !Number.isSafeInteger(dimA) || dimA <= 0
          || descA.length !== kpsA.length * dimA || descB.length !== kpsB.length * dimB
          || (settings.matcher === 'lightglue' && !learnedDetector(srcA.detector))) {
        throw new Error('Incompatible descriptors — detect both images with the same detector before matching')
      }

      // Subset gate (brute-force only): a cheap coarse pre-test that rejects
      // non-overlapping pairs before the full O(Na·Nb) match. Match a small
      // spatially-uniform subset of each image's descriptors; if too few survive,
      // skip the pair entirely. Keeps exhaustive *coverage* (loop closures are
      // still found anywhere in the graph) at a fraction of the cost per pair —
      // the win when there are no poses for proximity preselection. Only kicks in
      // when both images have meaningfully more keypoints than the subset, so
      // small images just pay the full match. See core/features/subsetGate.js.
      //
      // `_skipSubsetGate` is matchAll's per-run veto (see there): preselection already
      // being the overlap prefilter, or too few pairs for the saving to be worth the
      // false-negative risk. Set on the settings object rather than checked here
      // because both reasons are properties of the *run*, not of this pair.
      const gateEnabled = settings.subsetGate !== false && settings.matcher !== 'lightglue'
        && !settings._skipSubsetGate
      if (gateEnabled) {
        // Size the sample from THIS pair's actual keypoint counts, not a fixed
        // figure: the gate's threshold is applied to a sampled count, so holding
        // the sample size fixed makes the test ~1/N more severe as keypoint counts
        // rise — at the Detailed detection preset a fixed 200 would veto nearly
        // every pair. See core/features/subsetGate.js for the arithmetic.
        // `_gateScale` (matchAll's rescue pass): the same test on a k× larger sample —
        // k² more expected putatives on a real pair, still a few % of the full match.
        const k = settings._gateScale > 1 ? settings._gateScale : 1
        const gateSizing = resolveSubsetGateSize(kpsA.length, kpsB.length, {
          floorSize: settings.subsetGateSize,
          ...(k > 1 ? { fraction: SUBSET_GATE_SIZE_DEFAULTS.fraction * k, minSize: SUBSET_GATE_SIZE_DEFAULTS.minSize * k,
            maxSize: SUBSET_GATE_SIZE_DEFAULTS.maxSize * k } : {}),
        })
        const gateSize = gateSizing.size
        const dim = srcA.descDim ?? 128
        if (kpsA.length > gateSize * 1.5 && kpsB.length > gateSize * 1.5) {
          const idxA = pickSpreadIndices(kpsA, gateSize)
          const idxB = pickSpreadIndices(kpsB, gateSize)
          const subA = sliceDescriptorRows(descA, idxA, dim)
          const subB = sliceDescriptorRows(descB, idxB, dim)
          const gate = await bruteForce(subA, subB, {
            ratioThreshold: settings.ratioThreshold,
            crossCheck: settings.crossCheck,
            dim,
          }, 'gate')
          const gateThreshold = settings.subsetGateThreshold
          entry.gateScore = gate.matches.length
          if (gate.matches.length < gateThreshold) {
            entry.rawCount = 0
            entry.status = 'done'
            entry.gated = true
            log(`Gated: ${imgA.name} ↔ ${imgB.name} — subset gate ${gate.matches.length}/${gateThreshold} `
              + `putatives on ${idxA.length}×${idxB.length}-kp subsets `
              + `(${(gateSizing.fraction * 100).toFixed(1)}% sample of ${kpsA.length}/${kpsB.length} kp`
              + `${gateSizing.clamped ? `, at the ${gateSizing.clamped === 'ceil' ? 'cost ceiling' : 'size floor'}` : ''})`
              + ' — skipping full match', 'debug', 'Matching')
            touchSoon()
            onDone?.(pid, entry)
            return
          }
          log(`Gate passed: ${imgA.name} ↔ ${imgB.name} — ${gate.matches.length} subset putatives `
            + `(≥${gateThreshold}) → full match`, 'debug', 'Matching')
        }
      }

      // Putative correspondences: LightGlue (learned joint matcher) or brute-force
      // NN + Lowe ratio. LightGlue needs keypoints + image sizes (it normalizes
      // coords internally); brute-force needs only descriptors. Either way `raw`
      // is a [{ia,ib}] list that flows through the same verify/gate path below.
      let raw
      if (settings.matcher === 'lightglue') {
        const [wA, hA] = imageDims(srcA, kpsA)
        const [wB, hB] = imageDims(srcB, kpsB)
        const res = await matchLightGlue({
          kpsA, descA, wA, hA, kpsB, descB, wB, hB,
          // LightGlue weights are trained per detector (SuperPoint ≠ DISK ≠ ALIKED).
          modelId: learnedDetector(srcA.detector).matcherModelId,
          minConf: settings.lgMinConf,
          maxKeypoints: settings.lgMaxKeypoints,
          useGpu: settings.useGpu,
          // Coarse-to-fine tiled guided matching (opt-in). When off, `tiled` is
          // falsy and the worker routes to the plain capped path. The guide
          // thresholds come from MATCH_TUNING via the settings merge above.
          tiled: settings.lgTiled,
          coarseKeypoints: settings.lgCoarseKeypoints,
          coarseGateMin: settings.lgCoarseGateMin,
          tileBudget: settings.lgTileBudget,
          guideMinMatches: settings.lgGuideMinMatches,
          guideMinInliers: settings.lgGuideMinInliers,
          guideMinInlierRatio: settings.lgGuideMinInlierRatio,
          guideRelThresh: settings.lgGuideRelThresh,
          tileMinKps: settings.lgTileMinKps,
        }, { ...timing('matchingMs'), onLog: (msg, level = 'info') => log(msg, level, 'Matching') })
        raw = res.matches
      } else {
        const res = await bruteForce(descA, descB, {
          ratioThreshold: settings.ratioThreshold,
          crossCheck: settings.crossCheck,
          // Descriptor width must match the detector: 128 (SIFT) vs 256 (SuperPoint).
          // The crate slices the flat buffer by `dim`; a wrong dim yields phantom
          // rows and out-of-range match indices → the `reading 'x'` crash in verify.
          dim: srcA.descDim ?? 128,
        }, 'full', [srcA.uuid, srcB.uuid])
        // One index per physical feature from here on: matches made through a
        // secondary SIFT orientation are re-expressed on the dominant keypoint and
        // deduplicated, so verification and SfM never see a feature twice (a split
        // track). No-op for images detected with one orientation.
        const sib = canonicalizeMatches(res.matches, canonFor(kpsA), canonFor(kpsB))
        raw = sib.matches
        entry.siblingMerged = sib.merged
        entry.siblingAmbiguous = sib.ambiguous
      }
      if (settings.filterStationary) {
        const [w, h] = imageDims(srcA, kpsA)
        const st = filterStationaryMatches(kpsA, kpsB, raw, { tolPx: stationaryTolPx(w, h, settings.stationaryTolPct) })
        raw = st.matches
        entry.stationaryDropped = st.dropped
      }
      entry.rawCount = raw.length

      const minMatches = settings.minMatches
      // Decoupled raw-putative skip (WS1): skipping below `rawSkipFloor` raw matches saves
      // the verify cost on pairs that clearly can't produce enough inliers — but it must
      // never be wider than the accept floor, or raising minMatches would silently kill
      // pairs before they're even verified (and before the weak-pair fallback can see them).
      const rawSkipFloor = Math.min(settings.rawSkipFloor, minMatches)

      if (raw.length < rawSkipFloor) {
        entry.status = 'done'
        entry.skipped = true
        const label = `${imgA.name} ↔ ${imgB.name}`
        log(`Skip: ${label} — only ${raw.length} raw matches (need ${rawSkipFloor})`, 'debug', 'Matching')
        touchSoon()
        onDone?.(pid, entry)
        return
      }

      if (settings.geometricVerification !== false) {
        // The RANSAC gate is in DETECTION pixels, but kpsA/kpsB are in native
        // pixels (detect.js maps them back), so resolve it against this pair's
        // detection scale. Per pair, not per run: two images may have been detected
        // at different scales, and the coarser one sets the epipolar noise floor.
        // Both at full resolution ⇒ factor 1 ⇒ the configured value, unchanged.
        const scaleCtx = pairScaleContext(srcA, srcB)
        const ransacPx = resolveScaledPx(settings.ransacThreshPx, scaleCtx)
        // A fisheye image verifies in its pinhole frame (core/features/verifyFrame.js);
        // `keep` maps the verified rows back to `raw` when off-axis putatives were left out.
        const packed = packMatchedPoints(kpsA, kpsB, raw)
        const { ptsA, ptsB, keep } = mapVerifyPoints(packed.ptsA, packed.ptsB, verifyMapperFor(imgA), verifyMapperFor(imgB))
        const verified = await verifyPointPairs(ptsA, ptsB, {
          ransacThreshPx: ransacPx,
          maxIters: settings.maxIters,
          verifier: settings.verifier,
          // Skip H-RANSAC on pairs below the hard acceptance floor: they're rejected
          // regardless of H, so the H/F degeneracy label is never consulted (see
          // verify_matches_hf). minMatches is the one un-overridable accept gate.
          hSkipBelow: minMatches,
        }, { ...timing('verificationMs'), avoidWorker })
        const result = verified && keep ? { ...verified, inlierMask: expandInlierMask(verified.inlierMask, keep, raw.length) } : verified
        // Classify via the pure gate (core/features/pairGate.js): accept / weak / reject.
        // `spread` is computed here (needs the store's keypoints); everything else is a
        // plain-data decision the gate owns so it can be unit-tested in isolation.
        const spread = result ? inlierSpread(kpsA, kpsB, raw, result.inlierMask) : null
        const verdict = evaluatePairAcceptance({ result, rawCount: raw.length, spread, settings })
        const { ratio, hfRatio, overrode } = verdict
        entry.hInlierCount = verdict.hInlierCount
        entry.hfRatio = hfRatio
        entry.degenerate = verdict.degenerate
        if (verdict.accept || verdict.weak) {
          // Both keep F + the inlier match list. A WEAK pair (valid F, enough inliers,
          // but below the accept gate) is preserved as a registration-only bridge:
          // sfm.js feeds it to PnP but never seeds init or triangulates from it.
          entry.F = result.F
          entry.inlierCount = result.inlierCount
          matches = packPutatives(raw, (i) => result.inlierMask[i] > 0.5)
          entry.weak = verdict.weak
          if (verdict.weak) entry.rejectReason = verdict.reason
        } else {
          entry.inlierCount = 0
          matches = EMPTY_MATCHES
          entry.rejectRatio = ratio // for the run summary stats
          entry.rejectReason = verdict.reason
        }
        // Detailed diagnostics (debug level): putatives, inliers, the ratio, and
        // the gate/threshold that decided the outcome — for every verified pair,
        // not just rejects (marginal accepts are the interesting ones to audit).
        log(`Match ${imgA.name} ↔ ${imgB.name} — ${raw.length} putatives → `
          + `${result?.inlierCount ?? 0} inliers (ratio ${ratio.toFixed(2)}, gate ${settings.minInlierRatio}`
          + `${overrode ? `, ratio-override on ${result.inlierCount}≥${settings.overrideInliers} inliers` : ''}), `
          + `H/F ${hfRatio.toFixed(2)}${entry.degenerate ? ' (degenerate — planar/pure-rotation, poor seed)' : ''}, `
          + `${spread ? `spread ${spread.uniqueA}/${spread.uniqueB} unique, ${spread.extentA.toFixed(0)}/${spread.extentB.toFixed(0)}px` : 'spread n/a'}`
          + `${verdict.spreadDegenerate ? ' (positional collapse — REJECTED)' : ''}`
          + `${verdict.weak ? ' (WEAK — PnP bridge only)' : ''}, `
          + `${settings.verifier === 'magsac' ? 'MAGSAC++' : 'RANSAC'} ${ransacPx.toFixed(2)}px`
          + `${scaleCtx.factor === 1 ? '' : ` (${settings.ransacThreshPx} detect-px ×${scaleCtx.factor.toFixed(2)} `
            + `for detection scale ${scaleCtx.medianScale.toFixed(3)})`}`, 'debug', 'Matching')
      } else {
        matches = packPutatives(raw)
        entry.inlierCount = raw.length
      }

      // Back into storage order: swap each [ia, ib] and transpose F (x_B·F·x_A = 0
      // becomes x_A·Fᵀ·x_B = 0). Every other entry field is symmetric in the roles.
      if (swapRoles) {
        matches = swapMatchRoles(matches)
        if (entry.F) entry.F = transposeF(entry.F)
      }
      holdMatches(pid, entry, matches)
      entry.status = 'done'

      // Every pair carrying inlier matches persists — accepted AND weak (a weak bridge
      // must survive a reload or the graph re-severs on restore): packMatchDocument
      // keeps any done pair with matches.
      markHeavy()

      const label = `${imgA.name} ↔ ${imgB.name}`
      // A pair with 0 inliers failed geometric verification — it is not a usable
      // match, so don't report it in green as a success. Weak pairs get their own line.
      if (entry.weak) {
        log(`Weak: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers, ${entry.rejectReason}`,
          'info', 'Matching')
      } else if (entry.inlierCount > 0) {
        log(`Matched: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers`, 'success', 'Matching')
      } else {
        // Report the recorded cause (ratio-gate vs absolute-inlier floor vs no model),
        // not a blanket "ratio too low" that misreads floor rejections.
        log(`Rejected: ${label} — ${entry.rawCount} raw matches, `
          + `${entry.rejectReason ?? 'none passed geometric verification'}`, 'debug', 'Matching')
      }
    } catch (err) {
      // A cancelled run hard-terminates the worker pool, so the in-flight worker
      // call rejects here — that's an expected user action, not a failure. Mark the
      // pair and return quietly (warn, not error) rather than throwing out of the
      // drain loop.
      entry.status = 'error'
      const msg = err?.message ?? String(err)
      const cancelled = /cancel/i.test(msg)
      log(`Match ${cancelled ? 'cancelled' : 'error'}: ${imgA.name} ↔ ${imgB.name}`
        + `${cancelled ? '' : ` — ${msg}`}`, cancelled ? 'warn' : 'error', 'Matching')
    }

    touchSoon()
    markHeavy()
    onDone?.(pairId(imgA.uuid, imgB.uuid), entry)
  }

  // Every way out of a pair — accepted, rejected, gated, missing descriptors, an
  // error — saves, so a superseded result can never resurrect: inside matchAll on
  // the periodic schedule, alone before returning.
  async function matchPair(...args) {
    const projectId = projects.currentProjectId
    try {
      await matchPairOnce(...args)
    } finally {
      if (projectId === projects.currentProjectId) {
        if (batchDepth > 0) schedulePersist()
        else await save()
      }
    }
  }

  // Camera positions (project CRS) from imported poses, keyed by image **uuid** —
  // the key every preselect step downstream uses (pairId is uuid-based). Poses link
  // to images by image.id (the name/size composite), so bridge id→uuid via the image
  // list; only resolved poses (imageId set, x/y present) count.
  function positionsByUuid(images) {
    const poseById = new Map()
    for (const p of posesStore.poses) {
      if (p.enabled !== false && p.imageId && Number.isFinite(p.x) && Number.isFinite(p.y))
        poseById.set(p.imageId, p)
    }
    const linked = []
    for (const img of images) {
      const pose = poseById.get(img.id)
      if (pose) linked.push({ uuid: img.uuid, pos: [pose.x, pose.y] })
    }
    return new Map(positionsForProximity(linked, projects.currentCrs)
      .map((item) => [item.uuid, item.pos]))
  }

  // Best footprint outer-ring per image, keyed by image **uuid** (same id→uuid
  // bridge as positionsByUuid). Prefers a computed set (one polygon per image, in
  // the project frame) over an imported one; first match wins otherwise.
  function footprintRingsByUuid(images) {
    const ringById = new Map() // image.id -> { ring, source }
    for (const set of useFootprintsStore().sets) {
      for (const fp of set.footprints) {
        if (!fp.imageId || !fp.rings?.length) continue
        const existing = ringById.get(fp.imageId)
        if (!existing || (existing.source !== 'computed' && set.source === 'computed'))
          ringById.set(fp.imageId, { ring: fp.rings[0], source: set.source })
      }
    }
    const m = new Map()
    for (const img of images) {
      const e = ringById.get(img.id)
      if (e) m.set(img.uuid, e.ring)
    }
    return m
  }

  async function matchAll(images, settings = {}, onProgress, shouldCancel) {
    restoreGeneration++
    // Same merge as matchPair so this function's own settings reads (and its
    // matchPair calls) all draw from the single source of truth.
    settings = applyTuningOverrides('match', { ...MATCH_DEFAULTS, ...MATCH_TUNING, ...settings },
      (msg) => log(msg, 'warn', 'Matching'))
    // The COUNT gates, never resident keypoints (they load per pair on demand).
    const ready = images.filter((img) => img.kpStatus === 'done' && (img.kpCount ?? 0) > 0)
    const strategy = settings.strategy ?? 'exhaustive'

    // LightGlue's weights are trained per learned detector (SuperPoint 256-d, DISK and
    // ALIKED 128-d) — refuse SIFT features or a mix, which would silently produce garbage.
    if (settings.matcher === 'lightglue') {
      const lg = lightGlueModelFor(ready)
      if (!lg.ok) {
        const names = lg.bad.map((im) => `"${im.name}" (${im.detector ?? 'sift'}/${im.descDim ?? 128}-d)`)
        const shown = names.slice(0, 5).join(', ')
        const more = names.length > 5 ? `, +${names.length - 5} more` : ''
        log(`${lg.reason}, but ${lg.bad.length} of `
          + `${pluralize(ready.length, 'image')} ${lg.bad.length === 1 ? 'is' : 'are'} not: ${shown}${more} — re-detect these (Overwrite mode), `
          + 'or switch the matcher to brute-force.', 'error', 'Matching')
        return
      }
      // Fetch the matching LightGlue weights (with consent) before dispatching.
      if (!(await useModelsStore().ensureReady([lg.modelId]))) {
        log('Matching cancelled — the LightGlue model is not available.', 'warn', 'Matching')
        return
      }
    }

    let pairs = []
    if (strategy === 'sequential') {
      pairs = sequentialPairs(ready, {
        overlap: settings.sequentialOverlap,
        loopClosure: settings.sequentialLoopClosure,
      })
      log(`Sequential pairing: each image ↔ next ${settings.sequentialOverlap} in capture order`
        + `${settings.sequentialLoopClosure ? ', with end-to-start loop closure' : ''}`
        + ` — ${pluralize(pairs.length, 'pair')}`, 'info', 'Matching')
    } else {
      for (let i = 0; i < ready.length; i++)
        for (let j = i + 1; j < ready.length; j++)
          pairs.push([ready[i], ready[j]])
    }

    // Preselection: prune the exhaustive set to pairs that plausibly overlap, so an
    // ordered block costs far less than O(N²). Two evidence sources — camera
    // proximity (imported poses) or ground overlap (image footprints). A pair with
    // an endpoint the chosen method can't judge is kept (never silently dropped).
    // Whether preselection actually pruned pairs (a requested preselect can fall
    // back to exhaustive when too few images carry footprints/positions — in that
    // case the subset gate must still run, as no overlap prefilter happened).
    //
    // Sequential pairing counts as an overlap prefilter for exactly the same reason
    // camera-proximity preselection does: it has ALREADY decided which pairs
    // plausibly overlap, using capture order. Running the subset gate on top of it
    // only removes chain links — and a sequential chain has no redundancy, so a
    // false veto severs the graph outright. Measured on the 128-image building set
    // (2026-07-25): 542 of 1280 sequential pairs gated, match graph split into 2
    // components (largest 85/128), 101 images left with zero correspondences to the
    // registered set. The gate's threshold is calibrated against strongly-overlapping
    // pairs; the weak links a chain depends on expect well under one subset putative.
    let overlapPrefiltered = strategy === 'sequential'
    if (strategy === 'preselect') {
      const method = settings.preselectMethod ?? 'position'
      if (method === 'footprint') {
        const rings = footprintRingsByUuid(ready)
        if (rings.size < 2) {
          log('Preselection: fewer than 2 images have footprints — matching exhaustively instead', 'warn', 'Matching')
        } else {
          const keep = preselectByFootprintOverlap(
            [...rings].map(([uuid, ring]) => ({ uuid, ring })),
            { minOverlap: (settings.minOverlap ?? 30) / 100 },
          )
          const before = pairs.length
          pairs = pairs.filter(([a, b]) =>
            (rings.has(a.uuid) && rings.has(b.uuid)) ? keep.has(pairId(a.uuid, b.uuid)) : true)
          overlapPrefiltered = true
          log(`Preselection: ${pairs.length}/${pluralize(before, 'pair')} kept, ${before - pairs.length} skipped `
            + `(footprint overlap ≥ ${settings.minOverlap ?? 30}%)`, 'info', 'Matching')
        }
      } else {
        const pos = positionsByUuid(ready)
        if (pos.size < 2) {
          log('Preselection: fewer than 2 images have camera positions — matching exhaustively instead', 'warn', 'Matching')
        } else {
          const keep = preselectPairs(
            [...pos].map(([uuid, p]) => ({ uuid, pos: p })),
            { maxNeighbors: settings.maxNeighbors },
          )
          const before = pairs.length
          pairs = pairs.filter(([a, b]) =>
            (pos.has(a.uuid) && pos.has(b.uuid)) ? keep.has(pairId(a.uuid, b.uuid)) : true)
          overlapPrefiltered = true
          log(`Preselection: ${pairs.length}/${pluralize(before, 'pair')} kept, ${before - pairs.length} skipped `
            + `(camera proximity, ≤${settings.maxNeighbors} neighbours)`, 'info', 'Matching')
        }
      }
    }

    if (pairs.length === 0) {
      log('Match: no image pairs to process (need at least 2 images with keypoints)', 'warn', 'Matching')
      return
    }

    // Two per-run reasons to bypass the subset gate, both properties of the run rather
    // than of any one pair:
    //  • the pair set was ALREADY chosen for overlap — by preselection (camera
    //    proximity / footprints) or by capture order (sequential) — so the gate can
    //    only add false negatives. It vetoed 52% of preselected pairs on a low-keypoint
    //    aerial block, and 42% of sequential pairs on the 128-image building set;
    //  • too few pairs for the saving to exist — the gate skips O(Na·Nb) work, which is
    //    worth a false-negative risk across hundreds of pairs and worth nothing across a
    //    handful, where a single wrong veto can sever the match graph.
    const gateApplies = settings.subsetGate !== false && settings.matcher !== 'lightglue'
    let skipSubsetGate = false
    if (gateApplies && overlapPrefiltered) {
      skipSubsetGate = true
      log(`Subset gate disabled: ${strategy === 'sequential' ? 'capture order is' : 'preselection is'}`
        + ' the overlap prefilter', 'info', 'Matching')
    } else if (gateApplies && pairs.length < settings.subsetGateMinPairs) {
      skipSubsetGate = true
      log(`Subset gate disabled: only ${pluralize(pairs.length, 'pair')} (< ${settings.subsetGateMinPairs}) `
        + '— matching them in full is cheap, and a wrong veto could sever the match graph',
        'info', 'Matching')
    }
    settings = { ...settings, _skipSubsetGate: skipSubsetGate }

    // LightGlue is pinned to worker 0 and its ORT session is not reentrant (two
    // concurrent session.run() on one wasm session deadlock — the old 7-way freeze).
    // Parallel drain loops would all pile onto worker 0 and wedge it, so dispatch
    // LightGlue serially; serial also keeps the progress bar honest. Brute-force
    // keeps the full pool (each matchPair issues its own round-robin worker calls).
    const concurrency = settings.matcher === 'lightglue'
      ? 1
      : Math.max(1, Math.min(POOL_SIZE, pairs.length))
    // Log the descriptor-matching knobs so a run's settings are auditable — in
    // particular whether cross-check (mutual nearest neighbour) is active, which
    // otherwise leaves no trace in the console yet meaningfully changes putatives.
    const crossCheck = settings.crossCheck
    const lightglue = settings.matcher === 'lightglue'
    log(`Matching: ${pluralize(pairs.length, 'pair')} — ${strategy}${concurrency > 1 ? `, ${concurrency}× parallel` : ''}`
      + `; matcher ${lightglue ? 'LightGlue (learned)' : 'brute-force'}`
      + `${lightglue ? '' : `, cross-check ${crossCheck ? 'on (mutual NN)' : 'off'}, ratio ${settings.ratioThreshold}`}`,
      'info', 'Matching')
    // Report the detection-scale correction once per run at info level (the
    // per-pair resolved value is debug). Built over the images actually taking
    // part, so it describes this run rather than the project.
    let resolvedRansacPx = null
    if (settings.geometricVerification !== false) {
      const runCtx = buildScaleContext(ready)
      resolvedRansacPx = resolveScaledPx(settings.ransacThreshPx, runCtx)
      if (runCtx.factor !== 1 || runCtx.mixed) {
        log(describeScaleContext(runCtx, `RANSAC gate (${settings.ransacThreshPx} detect-px)`),
          runCtx.clamped ? 'warn' : 'info', 'Matching')
      }
    }
    let done = 0
    // Tally this run's outcomes for the completion summary. Skipped = too few raw
    // matches to bother verifying; rejected = verified but failed the count/ratio
    // gate; matched = kept (with ≥1 inlier).
    const stats = { matched: 0, weak: 0, rejected: 0, skipped: 0, gated: 0, inliers: 0, ratios: [], degenerate: 0,
      siblingMerged: 0, siblingAmbiguous: 0, stationary: 0 }
    const tally = (_pid, entry) => {
      if (entry.status !== 'done') return
      stats.stationary += entry.stationaryDropped ?? 0
      stats.siblingMerged += entry.siblingMerged ?? 0
      stats.siblingAmbiguous += entry.siblingAmbiguous ?? 0
      // Order matters: outcome flags are mutually exclusive but explicit (weak/gated/
      // skipped) so a decoupled raw-skip floor never misclassifies a reject as a skip.
      if (entry.gated) stats.gated++
      else if (entry.skipped) stats.skipped++
      else if (entry.weak) stats.weak++
      else if (entry.inlierCount > 0) {
        stats.matched++; stats.inliers += entry.inlierCount
        if (entry.rawCount) stats.ratios.push(entry.inlierCount / entry.rawCount)
        // H/F degeneracy is a per-pair label (planar scene / pure rotation) that no
        // count or ratio gate acts on, so it only ever reached the debug log — yet the
        // run-level SHARE is a first-order diagnostic: how much of the graph is planar
        // or rotation-dominated, where F is not determined. Counted over ACCEPTED
        // pairs only, because that is the exact population where H ran: `hSkipBelow`
        // = minMatches skips H below the accept floor, so any other denominator would
        // dilute the share with pairs that were never evaluated.
        if (entry.degenerate) stats.degenerate++
      } else stats.rejected++
    }

    // WebGPU brute-force (Settings ▸ Compute "Use GPU"): one router per run, which
    // validates against WASM on the first pair and falls back per pair. LightGlue
    // has its own GPU path (ORT WebGPU EP) and never comes through here.
    const gpuRequested = !lightglue && !!settings.useGpu
    const gpuRun = gpuRequested
      ? await createGpuMatchRun({
        client: {
          begin: matchGpuBegin,
          end: matchGpuEnd,
          gpuMatch: matchDescriptorsGpu,
          cpuMatch: (a, b, o, hooks) => matchDescriptors(a, b, o, { ...hooks, avoidWorker: GPU_MATCH_WORKER }),
        },
        log: (msg, level) => log(msg, level, 'Matching'),
        cacheBudgetBytes: settings.gpuDescCacheMiB * 2 ** 20,
        shouldCancel: () => !!shouldCancel?.(),
      })
      : null
    if (!lightglue && !gpuRun) {
      log(`Matching: backend = WASM (CPU)${gpuRequested ? '' : ' — enable "Use GPU" in Settings ▸ Compute for the WebGPU matcher'}`,
        'info', 'Matching')
    }

    // Each image's descriptors load from OPFS once per run, and are released after its
    // last pair or under a byte budget (stores/matching/descriptorCache.js).
    const descCache = createDescriptorCache({ pairs, budgetBytes: (settings.descCacheMiB ?? 2048) * 2 ** 20 })
    // Concurrency-limited dispatch: `concurrency` drain loops pull from a shared
    // cursor so up to POOL_SIZE pairs are matched at once (each matchPair issues its
    // own round-robin worker calls). Cancellation is cooperative — stop pulling.
    let cursor = 0
    let cancelled = false
    const drain = async () => {
      while (true) {
        if (cancelled || shouldCancel?.()) { cancelled = true; return }
        const i = cursor++
        if (i >= pairs.length) return
        const [a, b] = pairs[i]
        await matchPair(a, b, settings, tally, descCache, gpuRun)
        descCache.release(a.uuid); descCache.release(b.uuid)
        done++
        onProgress?.(done, pairs.length)
      }
    }
    const runStarted = performance.now()
    let backendRecord = lightglue ? null : { backend: 'wasm', gpuRequested }
    batchDepth++
    try {
      await Promise.all(Array.from({ length: concurrency }, drain))
      // Gate rescue. The subset gate's sample count scales with the pair's TRUE match
      // count, so a real pair with a few hundred matches reads as ~0–2 sampled
      // putatives and is vetoed — the side-lap pairs of a film block. Iceland 1980
      // (125 scans, ~9600 kp): 7415/7750 pairs gated, 334 accepted (COLMAP verified
      // 746, half of them under 300 inliers); a 7-image strip hung off the block by
      // one pair and never registered. Images left with fewer than
      // subsetGateRescueDegree accepted pairs re-test their gated pairs on a
      // subsetGateRescueScale× larger sample; those that pass get the full match.
      const rescueDegree = settings.subsetGateRescueDegree ?? 0
      if (!cancelled && !shouldCancel?.() && rescueDegree > 0 && settings.subsetGate !== false && !lightglue && !settings._skipSubsetGate) {
        const degree = new Map()
        const bump = (u) => degree.set(u, (degree.get(u) ?? 0) + 1)
        for (const [a, b] of pairs) {
          const e = matchStore.value.get(pairId(a.uuid, b.uuid))
          if (e?.status === 'done' && !e.gated && (e.inlierCount ?? 0) > 0) { bump(a.uuid); bump(b.uuid) }
        }
        const low = (u) => (degree.get(u) ?? 0) < rescueDegree
        const rescue = pairs.filter(([a, b]) => matchStore.value.get(pairId(a.uuid, b.uuid))?.gated && (low(a.uuid) || low(b.uuid)))
        if (rescue.length) {
          const nLow = new Set(rescue.flatMap(([a, b]) => [a, b]).filter((im) => low(im.uuid)).map((im) => im.uuid)).size
          const before = { matched: stats.matched, weak: stats.weak }
          stats.gated -= rescue.length // re-tallied by the rescue run
          log(`Matching: gate rescue — ${pluralize(nLow, 'image')} under ${pluralize(rescueDegree, 'accepted pair')}; re-testing their `
            + `${pluralize(rescue.length, 'gated pair')} on a ${settings.subsetGateRescueScale}× larger sample`, 'info', 'Matching')
          const rescueSettings = { ...settings, _gateScale: settings.subsetGateRescueScale ?? 4 }
          const rescueCache = createDescriptorCache({ pairs: rescue, budgetBytes: (settings.descCacheMiB ?? 2048) * 2 ** 20 })
          let rc = 0
          const total = pairs.length + rescue.length
          const drainRescue = async () => {
            while (true) {
              if (cancelled || shouldCancel?.()) { cancelled = true; return }
              const i = rc++
              if (i >= rescue.length) return
              const [a, b] = rescue[i]
              await matchPair(a, b, rescueSettings, tally, rescueCache, gpuRun)
              rescueCache.release(a.uuid); rescueCache.release(b.uuid)
              done++
              onProgress?.(done, total)
            }
          }
          await Promise.all(Array.from({ length: concurrency }, drainRescue))
          log(`Matching: gate rescue recovered ${stats.matched - before.matched} accepted`
            + `${stats.weak - before.weak ? ` + ${stats.weak - before.weak} weak` : ''} ${nounFor(stats.matched - before.matched + stats.weak - before.weak, 'pair')} of ${rescue.length} re-tested`,
          'info', 'Matching')
        }
      }
    } finally {
      batchDepth--
      // Flush matchPair's throttled reactivity so everything reading the store's
      // computeds after the run sees the final state.
      touch()
      // One save for the whole run (and for a cancelled one, so what matched survives).
      await save()
      const dc = descCache.stats()
      log(`Matching: descriptors loaded ${dc.loads}× for ${pluralize(ready.length, 'image')}, `
        + `resident peak ${(dc.peakBytes / 2 ** 20).toFixed(0)} MiB`, 'debug', 'Matching')
      // Always release the GPU-side descriptor cache, unless Cancel already
      // terminated the pool (and with it the cache).
      if (gpuRun) backendRecord = await gpuRun.finish({ cancelled: cancelled || !!shouldCancel?.() })
    }
    const timings = { wallMs: performance.now() - runStarted, descriptorLoadMs: 0, descriptorBytes: 0,
      postMessageMs: 0, matchingMs: 0, verificationMs: 0, roundTripMs: 0 }
    for (const [a, b] of pairs) {
      const t = matchStore.value.get(pairId(a.uuid, b.uuid))?.timing
      if (t) for (const key of Object.keys(t)) timings[key] += t[key]
    }
    log(`Matching timing: wall ${(timings.wallMs / 1000).toFixed(2)}s; summed pair stages: `
      + `descriptor loads ${(timings.descriptorLoadMs / 1000).toFixed(2)}s, `
      + `postMessage serialization ${(timings.postMessageMs / 1000).toFixed(2)}s, `
      + `matching ${(timings.matchingMs / 1000).toFixed(2)}s, verification ${(timings.verificationMs / 1000).toFixed(2)}s; `
      + `queue/transport remainder ${(Math.max(0, timings.roundTripMs - timings.matchingMs - timings.verificationMs - timings.postMessageMs) / 1000).toFixed(2)}s. `
      + `Concurrent stage sums can exceed wall time.`, 'info', 'Matching')
    if (cancelled || shouldCancel?.()) {
      log(`Matching cancelled — ${done}/${pairs.length} done`, 'warn', 'Matching')
      return
    }
    const meanRatio = stats.ratios.length
      ? stats.ratios.reduce((s, r) => s + r, 0) / stats.ratios.length : 0
    log(`Matching complete: ${pluralize(pairs.length, 'pair')} — ${stats.matched} accepted`
      + `${stats.weak ? `, ${stats.weak} weak (PnP bridges)` : ''}`
      + `, ${stats.rejected} rejected, ${stats.skipped} skipped`
      + `${stats.gated ? `, ${stats.gated} gated (subset pre-test)` : ''}`
      + `${settings.filterStationary ? `; ${pluralize(stats.stationary, 'stationary putative')} dropped` : ''}`
      + `; ${stats.inliers} total inliers, mean inlier ratio ${meanRatio.toFixed(2)}`
      + `${stats.matched ? `, ${stats.degenerate}/${pluralize(stats.matched, 'accepted pair')} H/F-degenerate `
        + `(${(100 * stats.degenerate / stats.matched).toFixed(0)}% planar / pure-rotation)` : ''}`,
      'success', 'Matching')
    if (stats.siblingMerged || stats.siblingAmbiguous) {
      log(`SIFT orientation siblings: ${pluralize(stats.siblingMerged, 'duplicate putative')} merged onto their dominant `
        + `keypoint, ${pluralize(stats.siblingAmbiguous, 'ambiguous putative')} dropped (one feature matched to two)`,
        'info', 'Matching')
    }

    matchRun.value = {
      timings,
      date: new Date().toISOString(),
      strategy,
      matcher: settings.matcher === 'lightglue' ? 'lightglue' : 'bruteforce',
      // Brute-force backend actually used: 'wasm' | 'gpu' | 'gpu→wasm' (+ the GPU
      // validation verdicts, fallback count and cache counters). null for LightGlue.
      backend: backendRecord,
      nImages: ready.length,
      nPairs: pairs.length,
      accepted: stats.matched,
      weak: stats.weak,
      rejected: stats.rejected,
      skipped: stats.skipped,
      gated: stats.gated,
      inliers: stats.inliers,
      meanInlierRatio: meanRatio,
      // Degenerate count + its denominator travel together: a bare count is unreadable
      // without knowing how many pairs H was actually evaluated on (accepted pairs).
      degenerate: stats.degenerate,
      degenerateOf: stats.matched,
      // Orientation-sibling canonicalization (core/features/orientationSiblings.js).
      siblingMerged: stats.siblingMerged,
      siblingAmbiguous: stats.siblingAmbiguous,
      subsetGateActive: gateApplies && !skipSubsetGate,
      resolvedRansacPx,
      // The user-facing knobs only — the tuning.js internals are not what a baseline
      // varies, and dumping the merged object would bury the five that matter.
      settings: {
        ratioThreshold: settings.ratioThreshold,
        crossCheck: settings.crossCheck,
        minMatches: settings.minMatches,
        minInlierRatio: settings.minInlierRatio,
        ransacThreshPx: settings.ransacThreshPx,
        maxIters: settings.maxIters,
        verifier: settings.verifier,
        subsetGate: settings.subsetGate,
        preselectMethod: strategy === 'preselect' ? settings.preselectMethod : null,
        maxNeighbors: strategy === 'preselect' ? settings.maxNeighbors : null,
        sequentialOverlap: strategy === 'sequential' ? settings.sequentialOverlap : null,
        sequentialLoopClosure: strategy === 'sequential' ? settings.sequentialLoopClosure : null,
        lgTiled: settings.matcher === 'lightglue' ? settings.lgTiled : null,
      },
    }
  }

  // Drop every pair involving `uuid`. Re-detecting an image (or clearing its
  // keypoints) renumbers its keypoint indices, so any stored match referencing
  // the old indices is now wrong — invalidate them rather than let stale indices
  // corrupt a later match/reconstruct run.
  function removeMatchesForImage(uuid) {
    restoreGeneration++
    let removed = 0
    for (const [pid, e] of matchStore.value) {
      if (e.idA === uuid || e.idB === uuid) {
        matchStore.value.delete(pid)
        matchCache.delete(pid)
        removed++
      }
    }
    if (removed) {
      markHeavy()
      save()
      touch()
      log(`Matches invalidated: ${pluralize(removed, 'pair')} — keypoints changed, re-match these`, 'warn', 'Matching')
    }
    return removed
  }

  // Bulk import pairs whose feature indices already refer to the current image
  // keypoint arrays. External image ordering is normalized to the store's sorted
  // uuid ordering here; when it flips, each [ia,ib] pair flips with it.
  async function importMatches(entries, { replace = false } = {}) {
    restoreGeneration++
    let imported = 0, skipped = 0
    for (const src of entries || []) {
      if (!src.uuidA || !src.uuidB || src.uuidA === src.uuidB) { skipped++; continue }
      const [idA, idB] = [src.uuidA, src.uuidB].sort()
      const pid = pairId(idA, idB)
      if (!replace && matchStore.value.has(pid)) { skipped++; continue }
      const flip = idA !== src.uuidA
      const matches = toMatchArray(src.matches).slice()
      if (flip) for (let i = 0; i < matches.length; i += 2) { const t = matches[i]; matches[i] = matches[i + 1]; matches[i + 1] = t }
      const entry = {
        idA, idB, rawCount: src.rawCount ?? matches.length / 2,
        inlierCount: src.verified === false ? 0 : (src.inlierCount ?? matches.length / 2),
        F: flip && src.F ? transpose3(src.F) : (src.F ?? null),
        nMatches: 0, src: null, status: 'done', enabled: true, weak: src.verified === false,
        source: src.source ?? 'external',
      }
      holdMatches(pid, entry, matches)
      matchStore.value.set(pid, entry)
      imported++
    }
    touch()
    if (imported) { markHeavy(); await save() }
    log(`Matches imported: ${pluralize(imported, 'pair')}${skipped ? `, ${skipped} skipped` : ''}`,
      imported ? 'success' : 'warn', 'Import')
    return { imported, skipped }
  }

  function transpose3(m) {
    return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
  }

  // Include or exclude a verified pair from reconstruction. A reversible user
  // override for obviously-wrong matches that clear every automatic gate; an
  // excluded pair stays stored (and re-enablable) but is filtered out at
  // reconstruct time. Like GCPs, poses and scale bars: `enabled` = takes part.
  function setPairEnabled(pid, enabled) {
    const entry = matchStore.value.get(pid)
    if (!entry || (entry.enabled !== false) === !!enabled) return false
    entry.enabled = !!enabled
    touch()
    save() // flags only: the matches buffers are reused
    log(`Pair ${enabled ? 'restored to' : 'excluded from'} reconstruction`, 'info', 'Matching', { channel: 'activity' })
    return true
  }

  // Project-store contract.
  async function restore({ projectId, report = () => {} }) {
    const generation = ++restoreGeneration
    matchStore.value = new Map()
    matchCache.clear()
    matchLoads.clear()
    committed = null
    matchesFile = null
    // Project open reads the match graph's INDEX only — pairs, counts, flags, F: every
    // summary the UI and the gates need, ~93 B per pair. Each pair's matches stay in
    // the document's matches column (a File, nothing read) until something asks for
    // them (ensurePairMatches / streamPairMatches). Descriptors stay lazy too.
    report('Reading image pairs')
    let doc = null, unreadable = null
    try {
      doc = await opfs.loadMatchIndex(projectId, MATCH_INDEX_KEYS)
    } catch (err) { unreadable = err }
    if (generation !== restoreGeneration || projectId !== projects.currentProjectId) return
    let restored = []
    if (doc || unreadable) {
      try {
        if (unreadable) throw unreadable
        restored = unpackMatchIndex(doc.meta, doc.buffers, { matchBytes: doc.matchesFile?.size ?? 0 })
        for (const [, e] of restored) {
          e.src = doc.matchesFile ? { file: doc.matchesFile, off: e.off } : null
          delete e.off
        }
        committed = { projectId, heavyVersion, meta: doc.meta, files: doc.files }
        matchesFile = doc.matchesFile
      } catch (err) {
        restored = []
        log(`Matches: the saved match document is unreadable (${err.message}) — re-run matching`, 'error', 'Matching')
      }
    }
    matchStore.value = new Map(restored)
    if (restored.length > 0) log(`Matches restored: ${pluralize(restored.length, 'pair')}`, 'success', 'Matching')
  }

  // Reset in-memory matches. Only purge deletes the persisted match files — a plain
  // clear (project switch/close) must leave them, since restore reads them back. On
  // a switch currentProjectId already names the project being opened.
  function clear({ purge = false } = {}) {
    const removed = matchStore.value.size
    restoreGeneration++
    matchStore.value.clear()
    matchStore.value = new Map()
    matchCache.clear()
    matchLoads.clear()
    matchRun.value = null
    committed = null
    matchesFile = null
    if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null }
    if (purge && isPersisting()) {
      opfs.clearAllMatches(projects.currentProjectId).catch(() => {})
    }
    if (purge && removed) {
      log(`Removed ${removed} match pair${removed === 1 ? '' : 's'}`, 'info', 'Matching', { channel: 'activity' })
    }
  }

  return {
    matchStore, matchRun, pairId, getMatch, verifiedPairs, usableMatchCount,
    matchPair, matchAll, importMatches, removeMatchesForImage, setPairEnabled, restore, clear,
    // A pair's matches on demand (the "A pair's matches" section at the top).
    ensurePairMatches, readPairMatches, residentPairMatches, streamPairMatches, matchCacheStats,
    // After the project root moved (browser storage ⇄ folder): re-point at the copy.
    rebindMatchesFile,
  }
}))
