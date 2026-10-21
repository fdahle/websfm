import { shallowRef, triggerRef, computed, markRaw } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'
import { createPairMatcher } from './matching/pairMatch.js'
import { createMatchAll } from './matching/matchAll.js'
import {
  packMatchDocument, packMatchFlags, unpackMatchIndex, toMatchArray, MATCH_HEAVY_KEYS, MATCH_INDEX_KEYS, isPersistedMatchEntry, planMatchReads, matchByteRange,
} from '../core/features/matchStorage.js'
import { createByteLru } from '../utils/byteLru.js'
import { useLog } from '../composables/useLog.js'
import { siblingCanonicalMap } from '../core/features/orientationSiblings.js'
import { RESIDENT_TUNING } from '../core/tuning.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { pluralize } from '../core/textFormat.js'

const EMPTY_MATCHES = new Uint32Array(0)

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

  const { verifyMapperFor, matchPairOnce } = createPairMatcher({
    canonFor, holdMatches, isPersisting, log, markHeavy, matchCache, matchStore, packPutatives, pairId, projects, touchSoon,
  })

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

  // matchAll's hold on the store's counters (see `batchDepth` and `restoreGeneration`).
  const beginBatch = () => { batchDepth++ }
  const endBatch = () => { batchDepth-- }
  const bumpGeneration = () => { restoreGeneration++ }
  const { positionsByUuid, footprintRingsByUuid, matchAll } = createMatchAll({
    log, matchPair, matchRun, matchStore, pairId, posesStore, projects, save, touch, beginBatch, endBatch, bumpGeneration,
  })

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
