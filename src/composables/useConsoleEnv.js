import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useMeasurementsStore } from '../stores/useMeasurementsStore.js'
import { useWorkflowsStore } from '../stores/useWorkflowsStore.js'
import { tuningOverrides, setTuningOverride } from '../stores/tuningOverrides.js'
import { useLog } from './useLog.js'

const SOURCE = 'Console'

// The environment the console's executor (core/help/console.js) acts through: the
// command dispatch and guard state App already has, the workflow runner, and the
// stores the verbs read and change. Built once in App.vue, so the runner's pauses are
// reported even while the console panel is closed.
//
// Injected: dispatch (handleCommand), commandState (useRibbonState), workflowRunner
// (useWorkflowWiring), matchStats (useWorkspaceState).
export function useConsoleEnv({ dispatch, commandState, workflowRunner, matchStats }) {
  const { log, clear } = useLog()
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const matchesStore = useMatchesStore()
  const recon = useReconstructionStore()
  const gcps = useGcpsStore()
  const measurements = useMeasurementsStore()
  const workflows = useWorkflowsStore()

  // A run the console started: report what the runner waits for, since the builder
  // dialog that shows it may not be open. 'blocked' is reported by the executor.
  let consoleRun = false
  const PROMPTS = {
    interactive: 'complete the opened dialog, then type "continue" (or "stop")',
    reuse: 'type "reuse" to keep it, "continue" to run it again, or "stop"',
    warning: 'type "continue" or "stop"',
  }
  watch(
    () => workflowRunner.pause.value,
    (pause) => {
      if (consoleRun && pause && PROMPTS[pause.kind])
        log(`Workflow waiting: ${pause.message} — ${PROMPTS[pause.kind]}`, 'warn', SOURCE)
    },
  )

  function frameLabel() {
    const sig = recon.currentFrameSignature
    if (sig.source === 'georef') return `georeferenced in ${sig.crs} (metres)`
    if (sig.source === 'scalebars') return 'scaled by scale bars (metres, no CRS)'
    return 'model units (no georeference or scale)'
  }

  return {
    log: (message, level = 'info') => log(message, level, SOURCE),
    clear,
    state: () => commandState.value,
    dispatch,
    workflows: () => workflows.workflows,
    async startWorkflow(workflow) {
      consoleRun = true
      try {
        return await workflowRunner.start(workflow)
      } finally {
        consoleRun = false
      }
    },
    workflowStatus: () => ({ running: workflowRunner.running.value, pause: workflowRunner.pause.value }),
    respond: (action) => workflowRunner.respond(action),
    stopWorkflow: () => workflowRunner.stop(),
    stats() {
      const sparse = recon.mainSparseCloud
      const ms = matchStats.value
      return {
        images: images.value.length,
        detected: images.value.filter((i) => i.kpStatus === 'done').length,
        keypoints: images.value.reduce((n, i) => n + (i.kpCount || 0), 0),
        pairs: { total: ms.total, verified: ms.verified, excluded: ms.excluded, weak: ms.weak, failed: ms.error },
        sparse: sparse ? { cameras: sparse.cameras?.size ?? 0, points: sparse.points?.length ?? 0 } : null,
        depthMaps: recon.depthMapCount,
        dense: recon.clouds.filter((c) => c.kind === 'dense').map((c) => ({ name: c.name, points: c.count })),
        meshes: recon.clouds
          .filter((c) => c.kind === 'mesh')
          .map((c) => ({ name: c.name, triangles: c.count, textured: !!c.texture })),
        dem: recon.dem
          ? {
              width: recon.dem.width,
              height: recon.dem.height,
              gsd: recon.dem.gsd,
              unit: recon.dem.unit === 'model' ? 'model units' : (recon.dem.unit ?? ''),
            }
          : null,
        ortho: recon.ortho
          ? {
              width: recon.ortho.width,
              height: recon.ortho.height,
              gsd: recon.ortho.gsd,
              unit: recon.ortho.unit === 'model' ? 'model units' : (recon.ortho.unit ?? ''),
            }
          : null,
        gcps: gcps.gcps.length,
        measurements: measurements.records.length,
        frame: frameLabel(),
      }
    },
    images: () => images.value.map((i) => ({ id: i.id, uuid: i.uuid, name: i.name })),
    matchPairs() {
      const byUuid = new Map(images.value.map((i) => [i.uuid, i]))
      const out = []
      for (const [, e] of matchesStore.matchStore) {
        if (e.status !== 'done' || !(e.inlierCount > 0)) continue
        const a = byUuid.get(e.idA),
          b = byUuid.get(e.idB)
        if (!a || !b) continue
        out.push({
          nameA: a.name,
          nameB: b.name,
          idA: a.id,
          idB: b.id,
          inliers: e.inlierCount,
          enabled: e.enabled !== false,
          weak: !!e.weak,
        })
      }
      return out
    },
    pairState(uuidA, uuidB) {
      const pid = matchesStore.pairId(uuidA, uuidB)
      const e = matchesStore.matchStore.get(pid)
      return e && e.status === 'done' && e.inlierCount > 0
        ? { pid, enabled: e.enabled !== false, inliers: e.inlierCount }
        : null
    },
    setPairEnabled: (pid, on) => matchesStore.setPairEnabled(pid, on),
    selectImage: (id) => imagesStore.selectImage(id),
    tuning: { get: tuningOverrides, set: setTuningOverride },
  }
}
