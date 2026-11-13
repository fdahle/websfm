// Dense Stage A's backend: WebGPU or the CPU (WASM) for the depth maps, chosen per run
// from the request, the device and what this session measured on it, and made ready
// before the first map (the GPU shader compiled, or the CPU threads started). Moved from
// workers/ops/dense.js (R2).

import { startThreadPool } from '../../core/sfm/reconstruction.js'
import { isGpuAvailable, ensureDevice } from '../gpu/device.js'
import { computeDepthMapGPU, prepareDepthMapGPU } from '../gpu/depthMapGpu.js'
import { depthMapForImage, geomDepthMapForImage } from '../../core/dense/mvs.js'
import { probeGivesUp } from '../../core/dense/gpuProbe.js'
import { DENSE_TUNING } from '../../core/tuning.js'

// Depth maps: GPU or CPU, as measured on a slow GPU (the probe in depthMaps below), per
// device for the life of this worker: a Full run's second pass and later runs start on
// the faster. 'broken': the GPU check on a first map failed (its cost is not the CPU's),
// so they run on the CPU too. GPUDevice → 'cpu' | 'gpu' | 'broken'.
export const gpuVerdict = new WeakMap()
// Thrown by the GPU-or-CPU comparison's CPU map when it cannot win (the probe in depthMaps).
export const PROBE_LOST = Symbol('probe lost')

// The backend a run starts on, logged: `backend` the GPU depth-map function or undefined
// (the WASM default), `gpuDevice` the device the verdicts are kept for, and what the
// run changes: `gpuFallbacks` (times it left the GPU), `probe`, `gpuMaps`.
export async function chooseDepthBackend(settings, emit) {
  // Backend selection: opt into the (experimental) WebGPU path with settings.useGpu;
  // anything that prevents it (no WebGPU, no adapter) silently keeps the WASM path.
  // `backend = undefined` ⇒ depthMapForImage uses its WASM default.
  let backend
  let gpuDevice = null
  if (settings.useGpu && isGpuAvailable()) {
    const state = await ensureDevice()
    if (state && gpuVerdict.get(state.device) === 'cpu') {
      emit('log', [
        'Depth maps: the CPU was measured faster than this GPU earlier in this session — running on the CPU',
        'info',
        'Dense',
      ])
    } else if (state && gpuVerdict.get(state.device) === 'broken') {
      emit('log', [
        "Depth maps: this GPU's matching cost differed from the CPU's earlier in this session — running on the CPU",
        'warn',
        'Dense',
      ])
    } else if (state) {
      backend = computeDepthMapGPU
      gpuDevice = state.device
      const id = [
        ...new Set([state.info?.vendor, state.info?.architecture || state.info?.description].filter(Boolean)),
      ].join(' ')
      emit('log', [
        `Depth maps: backend = WebGPU${id ? ` (${id})` : ''}` +
          `${state.isFallback ? ' [software adapter]' : ''} — multi-source PatchMatch (experimental)`,
        'warn',
        'Dense',
      ])
    } else {
      emit('log', ['Depth maps: GPU requested but no adapter — using WASM (CPU)', 'warn', 'Dense'])
    }
  }
  if (!backend) emit('log', ['Depth maps: backend = WASM (CPU)', 'info', 'Dense'])
  // The run's backend state; depthMapOnBackend updates it map by map.
  return { backend, gpuDevice, gpuFallbacks: 0, probe: null, gpuMaps: 0 }
}

// Make the backend ready before the first map: compile the GPU shader and measure the
// browser's wait for finished GPU work, or start the CPU threads (`cpuThreads`; also
// when the shader does not compile). → false when the run must leave the GPU.
export async function warmUpDepthBackend({ backend, cpuThreads, total, emit }) {
  let shaderOk = true
  if (backend) {
    // Compile the GPU shader and measure the browser's fixed wait for finished GPU work
    // before the first map (depthMapGpu.js getPipeline), so neither counts as map time.
    // A shader that does not compile: the CPU.
    emit('progress', [0, total, 'Preparing the GPU…', 0])
    const t0 = performance.now()
    try {
      const { waitMs } = (await prepareDepthMapGPU()) ?? { waitMs: 0 }
      const secs = ((performance.now() - t0) / 1000).toFixed(1)
      emit('log', [
        `Depth maps: GPU shader ready in ${secs} s; the browser reports finished GPU work after ${waitMs.toFixed(1)} ms`,
        'info',
        'Dense',
      ])
    } catch (err) {
      emit('log', [
        `Depth maps: the GPU shader did not compile (${err?.message ?? err}) — running on the CPU (WASM)`,
        'warn',
        'Dense',
      ])
      shaderOk = false
    }
  }
  if ((!backend || !shaderOk) && cpuThreads) {
    // Start the pool before the first map, and say so: it takes seconds (each thread
    // instantiates the module), and the run otherwise sat at 0 % without a word. A pool
    // that does not start leaves one thread per map, many times slower: a warning.
    emit('progress', [0, total, 'Starting the CPU threads…', 0])
    const t0 = performance.now()
    const threads = await startThreadPool(cpuThreads)
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    if (threads > 0) emit('log', [`Depth maps: ${threads} threads (started in ${secs} s)`, 'info', 'Dense'])
    else
      emit('log', [
        'Depth maps: the threaded build did not start here, so each map runs on one thread (much slower)',
        'warn',
        'Dense',
      ])
  }
  return shaderOk
}

// One depth map on the run's backend (`bk`, chooseDepthBackend), with its fallbacks: a
// GPU error or a failed GPU check computes it again on the CPU and keeps the rest of the
// run there, and on a slow GPU the probe computes one map on the CPU to compare (the CPU
// map gives up once it cannot win). `job` is the map: its frame and sources, the hooks for
// its log and progress, `settingsFor(backend)` its settings on either backend, and
// `geomInputs` (the geometric pass: its first-pass planes and the sources' depths).
// → { dm, imgMs }; `bk` carries what changed for the next map.
export async function depthMapOnBackend(bk, job) {
  const { k, total, img, ref, sources, sparsePos, srcUuids, settingsFor, logHooks, geomInputs } = job
  const { canProbe, settings, emit } = job
  if (bk.probe) bk.backend = undefined
  const tImg = performance.now()
  // The probe's CPU map gives up after a pyramid level once it cannot win
  // (core/dense/gpuProbe.js) against what the GPU would take for this map, from its
  // time per pixel and source view.
  const gpuMapMs = bk.probe ? bk.probe.gpuMsPerUnit * ref.width * ref.height * Math.max(1, srcUuids.length) : 0
  let probeCourseMs = 0
  const probeHooks = (h) => ({
    ...h,
    onProgress: (f) => {
      const ms = performance.now() - tImg
      probeCourseMs = ms / Math.max(f, 1e-6)
      if (probeGivesUp(ms, f, gpuMapMs, settings.gpuProbeGiveUp)) throw PROBE_LOST
      h.onProgress?.(f)
    },
  })
  // Validate the GPU cost kernel against the CPU reference on the first image only.
  const hooks = { ...logHooks, validate: bk.backend && k === 0 }
  let ds = settingsFor(bk.backend)
  let dm
  if (geomInputs) {
    const { ph, srcDepth } = await geomInputs()
    try {
      dm = ph ? await geomDepthMapForImage(ref, sources, sparsePos, ph, srcDepth, ds, bk.backend) : null
    } catch (err) {
      if (!bk.backend) throw err
      emit('log', [
        `Depth maps: GPU error on ${img.name} (${err?.message ?? err}) — falling back to WASM`,
        'warn',
        'Dense',
      ])
      bk.backend = undefined
      bk.gpuFallbacks++
      ds = settingsFor(bk.backend)
      dm = await geomDepthMapForImage(ref, sources, sparsePos, ph, srcDepth, ds)
    }
  } else
    try {
      dm = await depthMapForImage(ref, sources, sparsePos, ds, bk.backend, bk.probe ? probeHooks(hooks) : hooks)
    } catch (err) {
      if (err === PROBE_LOST) {
        // The CPU cannot win: this map, and the rest, on the GPU.
        emit('log', [
          `Depth maps: the CPU was on course to take ${(probeCourseMs / 1000).toFixed(0)} s for this map, ` +
            `the GPU ${(gpuMapMs / 1000).toFixed(1)} s — the rest stay on the GPU`,
          'info',
          'Dense',
        ])
        bk.backend = bk.probe.gpu
        if (bk.gpuDevice) gpuVerdict.set(bk.gpuDevice, 'gpu')
        bk.probe = null
        ds = settingsFor(bk.backend)
        dm = await depthMapForImage(ref, sources, sparsePos, ds, bk.backend, hooks)
      } else if (bk.backend) {
        // A GPU failure mid-run must not abort the whole batch: log it, drop to WASM
        // for this image and every image after, and retry once on the CPU path.
        emit('log', [
          `Depth maps: GPU error on ${img.name} (${err?.message ?? err}) — falling back to WASM`,
          'warn',
          'Dense',
        ])
        bk.backend = undefined
        bk.gpuFallbacks++
        // Keep streaming the coarse-to-fine plan log on the retry (validate no
        // longer applies once we've dropped off the GPU path).
        ds = settingsFor(bk.backend)
        dm = await depthMapForImage(ref, sources, sparsePos, ds, bk.backend, {
          onLog: hooks.onLog,
          onProgress: hooks.onProgress,
        })
      } else {
        throw err
      }
    }
  // The GPU check on the run's first map (depthMapForImage hooks.validate): a GPU whose
  // cost is not the Rust cost of the same planes (DENSE_TUNING.gpuCheckMax) computes
  // something else, a broken kernel or driver. This map again, the rest of the run and
  // later runs in this session on the CPU (gpuVerdict).
  if (bk.backend && dm?.gpuCheck && !dm.gpuCheck.ok) {
    emit('log', [
      `Depth maps: the GPU's matching cost differs from the CPU's on ${img.name} ` +
        `(median ${dm.gpuCheck.median.toExponential(1)}) — this run continues on the CPU (WASM), which is slower`,
      'warn',
      'Dense',
    ])
    bk.backend = undefined
    bk.gpuFallbacks++
    if (bk.gpuDevice) gpuVerdict.set(bk.gpuDevice, 'broken')
    ds = settingsFor(bk.backend)
    dm = await depthMapForImage(ref, sources, sparsePos, ds, bk.backend, {
      onLog: hooks.onLog,
      onProgress: hooks.onProgress,
    })
  }
  const imgMs = performance.now() - tImg
  {
    // Time per pixel and source view: the two maps compared see different images.
    const nSrcHere = Math.max(1, srcUuids.length)
    const units = ref.width * ref.height * nSrcHere
    const perMp = (msPerUnit) => ((msPerUnit * 1e6 * nSrcHere) / 1000).toFixed(1)
    if (bk.probe) {
      const cpuMsPerUnit = imgMs / units
      const cpuWins = cpuMsPerUnit < bk.probe.gpuMsPerUnit
      emit('log', [
        `Depth maps: the GPU took ${perMp(bk.probe.gpuMsPerUnit)} s per megapixel, the CPU ${perMp(cpuMsPerUnit)} s — ` +
          `${cpuWins ? 'the rest run on the CPU' : 'the rest stay on the GPU'}`,
        cpuWins ? 'warn' : 'info',
        'Dense',
      ])
      if (cpuWins) bk.gpuFallbacks++
      else bk.backend = bk.probe.gpu
      if (bk.gpuDevice) gpuVerdict.set(bk.gpuDevice, cpuWins ? 'cpu' : 'gpu')
      bk.probe = null
    } else if (bk.backend) {
      bk.gpuMaps++
      if (
        canProbe &&
        bk.gpuMaps === 2 &&
        !gpuVerdict.has(bk.gpuDevice) &&
        total - k > 2 &&
        imgMs > (settings.gpuProbeMs ?? DENSE_TUNING.gpuProbeMs)
      ) {
        emit('log', [
          `Depth maps: a map took ${(imgMs / 1000).toFixed(1)} s on the GPU — the next is computed on the CPU to compare`,
          'info',
          'Dense',
        ])
        bk.probe = { gpuMsPerUnit: imgMs / units, gpu: bk.backend }
      }
    }
  }
  return { dm, imgMs }
}
