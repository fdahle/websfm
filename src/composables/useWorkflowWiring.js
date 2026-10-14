import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useWorkflowsStore } from '../stores/useWorkflowsStore.js'
import { createWorkflow, resolveWorkflowSettings, WORKFLOW_BLOCK_BY_ID } from '../core/workflow.js'
import { useComputeSettings } from './useComputeSettings.js'
import { useLog } from './useLog.js'
import { useWorkflowRunner } from './useWorkflowRunner.js'

// Workflow execution wired to the app, lifted out of App.vue: the state the runner
// preflights against, how an automated block runs (and how it is judged to have
// replaced its output), and the builder dialog's handlers.
//
// Injected: `ready` (useWorkspaceState's readiness flags), `pipeline` (usePipeline's
// runners + cancelRun), `openInteractive(id)` (the command dispatch — an interactive
// block opens its command's own dialog).
export function useWorkflowWiring({ ready, pipeline, openInteractive }) {
  const { log } = useLog()
  const { kpImageCount, sparseReady, cloudReady, denseReady, meshReady, demReady, orthoReady } = ready
  const {
    runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify,
    runGenerateDem, runGenerateOrtho, runGenerateMesh, cancelRun,
  } = pipeline
  const { images } = storeToRefs(useImagesStore())
  const { matchRun, usableMatchCount } = storeToRefs(useMatchesStore())
  const { currentSceneType } = storeToRefs(useProjectsStore())
  const { clouds, mainSparseCloud, depthMaps, depthMapCount, dem, ortho } = storeToRefs(useReconstructionStore())
  const workflowsStore = useWorkflowsStore()
  const { addWorkflow, updateWorkflow, recordRun: recordWorkflowRun } = workflowsStore
  const { workflowBuilderOpen } = storeToRefs(useModalsStore())
  const { useGpu: workflowUseGpu, memBudgetBytes: workflowMemBudgetBytes } = useComputeSettings()

  // Workflow preflight/execution state uses semantic output names rather than UI
  // counter names. The runner re-reads this computed before every block, so outputs
  // produced by the previous stage become immediately reusable.
  const workflowState = computed(() => ({
    sceneType: currentSceneType.value,
    images: images.value.length > 0,
    keypoints: kpImageCount.value >= 2,
    matches: usableMatchCount.value > 0,
    sparse: sparseReady.value,
    depthMaps: depthMapCount.value > 0,
    cloud: cloudReady.value,
    dense: denseReady.value,
    dem: demReady.value,
    mesh: meshReady.value,
    surface: demReady.value || meshReady.value,
    ortho: orthoReady.value,
  }))

  async function runAutomatedWorkflowBlock(type, rawSettings) {
    const settings = resolveWorkflowSettings(type, rawSettings, {
      useGpu: workflowUseGpu.value,
      memBudgetBytes: workflowMemBudgetBytes.value,
    })
    const targets = type === 'detect-features'
      ? (settings.overwrite ? [...images.value] : images.value.filter((img) => img.kpStatus !== 'done'))
      : []
    const before = type === 'detect-features'
      ? new Map(targets.map((img) => [img.uuid, img.kpRev ?? 0]))
      : workflowOutputToken(type)

    let result
    if (type === 'detect-features') result = await runDetect(settings)
    else if (type === 'match-features') result = await runMatch(settings)
    else if (type === 'reconstruct') result = await runReconstruct(settings)
    else if (type === 'compute-depth') result = await runComputeDepthMaps(settings)
    else if (type === 'dense') result = await runDensify(settings)
    else if (type === 'gen-dem') result = await runGenerateDem(settings)
    else if (type === 'gen-ortho') result = await runGenerateOrtho(settings)
    else if (type === 'gen-mesh') result = await runGenerateMesh(settings)
    else throw new Error(`Workflow block is not automated: ${type}`)

    if (result?.ok === false || result?.unchanged) return result
    const changed = type === 'detect-features'
      ? targets.every((img) => img.kpStatus === 'done' && (img.kpRev ?? 0) !== before.get(img.uuid))
      : workflowOutputToken(type) !== before
    return changed
      ? { ok: true, cancelled: false }
      : { ok: false, cancelled: false, reason: `${WORKFLOW_BLOCK_BY_ID.get(type)?.label ?? type} did not replace its output` }
  }

  function workflowOutputToken(type) {
    if (type === 'match-features') return matchRun.value
    if (type === 'reconstruct') return mainSparseCloud.value
    if (type === 'compute-depth') return depthMaps.value
    if (type === 'dense') return clouds.value.find((c) => c.kind === 'dense' && !c.imported && !c.derived) ?? null
    if (type === 'gen-dem') return dem.value
    if (type === 'gen-ortho') return ortho.value
    if (type === 'gen-mesh') return clouds.value.find((c) => c.kind === 'mesh' && !c.imported && !c.derived) ?? null
    return null
  }

  const workflowRunner = useWorkflowRunner({
    state: workflowState,
    runAutomated: runAutomatedWorkflowBlock,
    cancelAutomated: cancelRun,
    openInteractive,
    recordRun: recordWorkflowRun,
    onLog: log,
  })
  const {
    running: workflowRunning, pause: workflowPause, statuses: workflowStatuses,
    currentBlockId: workflowCurrentBlockId,
  } = workflowRunner

  function addNewWorkflow() {
    addWorkflow(createWorkflow('Untitled workflow'))
  }
  // New projects clear the project stores without going through restore(). Opening
  // the builder must initialize its canvas as well as opening the dialog.
  watch(workflowBuilderOpen, (open) => {
    if (open) workflowsStore.ensureWorkflow()
  })
  function onWorkflowUpdate({ id, patch }) {
    updateWorkflow(id, patch)
  }
  function closeWorkflowBuilder() {
    if (!workflowRunning.value) {
      workflowRunner.respond('dismiss')
      workflowBuilderOpen.value = false
    }
  }
  function onWorkflowRun({ workflow, fromIndex, onlyIds }) {
    workflowRunner.start(workflow, { fromIndex, onlyIds: onlyIds ? new Set(onlyIds) : null })
  }

  return {
    workflowState, workflowRunner, workflowRunning, workflowPause, workflowStatuses, workflowCurrentBlockId,
    addNewWorkflow, onWorkflowUpdate, closeWorkflowBuilder, onWorkflowRun,
  }
}
