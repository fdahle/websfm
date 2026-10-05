// Per-run router for brute-force descriptor matching on WebGPU, with the WASM
// matcher as the fallback. Owned by `useMatchesStore.matchAll`; one instance per
// run, created only when the user enabled the GPU (Settings ▸ Compute) and the
// matcher is brute-force.
//
// Three rules, all logged:
//   • VALIDATE FIRST. The run's first full match — and, separately, its first
//     subset-gate match — runs on both backends (worker side, `matchGpu` with
//     `validate`) and logs the agreement. Every other pair of that kind waits for
//     the verdict; a failed check moves the REST OF THE RUN to WASM, and the
//     failing pair itself is answered from the WASM result.
//   • PER-PAIR FALLBACK. Any GPU error answers that pair on WASM; the first error is
//     logged, later ones are counted into the end-of-run summary. A CANCELLED run is
//     the exception: Cancel hard-terminates the pool, so every in-flight GPU call
//     rejects — falling back would spawn a fresh pool and run those pairs on WASM
//     after the user asked to stop. Once `shouldCancel()` is true, match() throws.
//   • SEND DESCRIPTORS ONCE. The GPU worker caches each image's descriptors for the
//     run, so a pair carries only uuids once both images were uploaded; a cache miss
//     (LRU eviction) comes back as `{ needs }` and the pair is resent with buffers.
//     Subset-gate samples differ per pair and are never cached (`id: null`).
//
// `client` is injected (computeClient in the app, a fake in tests):
//   { begin(opts), gpuMatch(args, hooks), end(opts), cpuMatch(descA, descB, opts, hooks) }

const MiB = 2 ** 20

function newRunId() {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function describeValidation(kind, v) {
  const pct = (v.share * 100).toFixed(2)
  return `GPU validate (${kind === 'gate' ? 'subset-gate' : 'full'} match, ${v.nA}×${v.nB} kp): `
    + `WASM ${v.nCpu} / GPU ${v.nGpu} matches, ${v.common} shared (${pct}% of the larger set; `
    + `≥99% and count within ±${v.countSlack} required) — ${v.pass ? 'PASS' : 'FAIL'}; `
    + `GPU ${v.gpuMs.toFixed(1)} ms vs WASM ${v.cpuMs.toFixed(0)} ms`
}

/**
 * @returns {Promise<null | { match: Function, finish: Function }>} null when the GPU
 *   is unavailable (already logged) — the caller then matches on WASM as before.
 */
export async function createGpuMatchRun({ client, log, cacheBudgetBytes, runId = newRunId(), shouldCancel = () => false }) {
  let init
  try {
    init = await client.begin({ runId, cacheBudgetBytes })
  } catch (err) {
    init = { ok: false, reason: err?.message ?? String(err) }
  }
  if (!init?.ok) {
    log(`Matching: GPU requested but unavailable (${init?.reason ?? 'unknown'}) — brute-force on WASM (CPU)`, 'warn')
    return null
  }
  const g = init.geometry
  log(`Matching: backend = WebGPU (${init.adapter}) — brute-force NN on ${g.tileA}×${g.tileB} tiles `
    + `(${g.workgroup} threads, ${g.microTile} per thread, k-chunk ${g.kChunk}), `
    + `≤${(init.macPerDispatch / 1e9).toFixed(1)} GMAC per dispatch; descriptor cache ${Math.round(init.budgetBytes / MiB)} MB `
    + `(requested ${Math.round(cacheBudgetBytes / MiB)} MB); ratio test + mutual NN in JS (nnSelect.js). `
    + 'Verification stays on WASM.', 'info')

  const sent = new Set()
  const gates = { full: null, gate: null }
  const validation = { full: null, gate: null }
  const counts = { full: 0, gate: 0 }
  let fallbacks = 0
  let resends = 0
  let firstError = null
  let disabledReason = null

  const disable = (reason) => {
    if (disabledReason) return
    disabledReason = reason
    log(`Matching: ${reason} — the rest of this run matches on WASM (CPU)`, 'error')
  }

  const checkCancel = () => { if (shouldCancel()) throw new Error('matching cancelled') }

  async function match(descA, descB, { idA = null, idB = null, dim, ratioThreshold, crossCheck, kind = 'full' }, hooks) {
    const cpu = () => { checkCancel(); return client.cpuMatch(descA, descB, { dim, ratioThreshold, crossCheck }, hooks) }
    checkCancel()
    let validator = false
    let release = null
    if (!gates[kind]) {
      validator = true
      gates[kind] = new Promise((resolve) => { release = resolve })
    } else {
      await gates[kind]
      checkCancel()
    }
    try {
      if (disabledReason) return await cpu()
      const base = { runId, idA, idB, dim, ratioThreshold, crossCheck, validate: validator }
      const needsBuf = (id) => validator || id == null || !sent.has(id)
      let res = await client.gpuMatch({
        ...base, descA: needsBuf(idA) ? descA : null, descB: needsBuf(idB) ? descB : null,
      }, hooks)
      if (res?.needs) {
        resends++
        res = await client.gpuMatch({ ...base, descA, descB }, hooks)
        if (res?.needs) throw new Error(`descriptor cache miss after resend (${res.needs.join(', ')})`)
      }
      if (idA != null) sent.add(idA)
      if (idB != null) sent.add(idB)
      if (validator && res.validation) {
        validation[kind] = res.validation
        log(describeValidation(kind, res.validation), res.validation.pass ? 'info' : 'error')
        if (!res.validation.pass) disable(`GPU/WASM disagreement on the first ${kind === 'gate' ? 'subset-gate' : 'full'} match`)
      }
      if (res.backend !== 'wasm') counts[kind]++
      return res
    } catch (err) {
      checkCancel()
      fallbacks++
      const msg = err?.message ?? String(err)
      if (!firstError) {
        firstError = msg
        log(`Matching: GPU error (${msg}) — this pair falls back to WASM; later errors are counted, not logged`, 'warn')
      }
      if (validator) disable(`GPU failed on its first ${kind === 'gate' ? 'subset-gate' : 'full'} match`)
      return await cpu()
    } finally {
      release?.()
    }
  }

  // `cancelled`: the pool was hard-terminated, so the worker (and its cache) is
  // already gone — don't spawn a fresh pool just to release nothing.
  async function finish({ cancelled = false } = {}) {
    let cache = null
    if (!cancelled) cache = await client.end({ runId }).catch(() => null)
    const backend = (fallbacks || disabledReason) ? 'gpu→wasm' : 'gpu'
    const parts = [`${counts.full} full + ${counts.gate} subset-gate match(es) on GPU`]
    if (fallbacks) parts.push(`${fallbacks} fell back to WASM after a GPU error (first: ${firstError})`)
    if (disabledReason) parts.push(`run moved to WASM: ${disabledReason}`)
    if (cache) {
      parts.push(`cache ${cache.uploads} upload(s) / ${(cache.uploadBytes / MiB).toFixed(0)} MB, `
        + `${cache.hits} hit(s), ${cache.misses} miss(es) → ${resends} resend(s), ${cache.evictions} eviction(s), `
        + `peak ${(cache.peakBytes / MiB).toFixed(0)} MB`)
      parts.push(`GPU kernel+readback ${(cache.gpuMs / 1000).toFixed(2)}s, JS selection ${(cache.selectMs / 1000).toFixed(2)}s (summed)`)
    }
    log(`Matching GPU summary: ${parts.join('; ')}`, fallbacks || disabledReason ? 'warn' : 'info')
    return {
      backend,
      gpuRequested: true,
      adapter: init.adapter,
      gpuMatches: { ...counts },
      fallbacks,
      firstError,
      disabledReason,
      validation: { ...validation },
      cache,
    }
  }

  return { match, finish }
}
