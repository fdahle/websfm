import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useWorkflowsStore } from '../stores/useWorkflowsStore.js'
import { createWorkflow, resolveWorkflowSettings, WORKFLOW_BLOCK_BY_ID } from '../core/workflow.js'
import { gateMetricValue, GATE_METRIC_BY_ID } from '../core/workflowGate.js'
import { cameraCenter } from '../core/sfm/geometry.js'
import { useComputeSettings } from './useComputeSettings.js'
import { useDatasetRecommendations } from './useDatasetRecommendations.js'
import { useLog } from './useLog.js'
import { useQualityReport } from './useQualityReport.js'
import { useWorkflowRunner } from './useWorkflowRunner.js'
import { pluralize } from '../core/textFormat.js'

// Workflow execution wired to the app, lifted out of App.vue: the state the runner
// preflights against, how an automated block runs (and how it is judged to have
// replaced its output), and the builder dialog's handlers.
//
// Injected: `ready` (useWorkspaceState's readiness flags, and `posedImageCount` for
// the Match block's automatic pairing), `pipeline` (usePipeline's
// runners + cancelRun), `openInteractive(id)` (the command dispatch — an interactive
// block opens its command's own dialog).
export function useWorkflowWiring({ ready, pipeline, openInteractive }) {
  const { log } = useLog()
  const { kpImageCount, sparseReady, cloudReady, denseReady, meshReady, demReady, orthoReady, posedImageCount } = ready
  // Lazy: the profile is only computed when a Match block resolves 'auto' pairing.
  const { profile: datasetProfile } = useDatasetRecommendations()
  const {
    runDetect, runMatch, runReconstruct, runComputeDepthMaps, runDensify,
    runGenerateDem, runGenerateOrtho, runGenerateMesh, runEditClouds, runTextureMesh, cancelRun,
  } = pipeline
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const { matchRun, usableMatchCount } = storeToRefs(useMatchesStore())
  const { currentSceneType } = storeToRefs(useProjectsStore())
  const { clouds, mainSparseCloud, depthMaps, depthMapCount, dem, ortho, denseSummary, meshSources } = storeToRefs(useReconstructionStore())
  const { computeHealth } = useQualityReport()
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
    texturedMesh: clouds.value.some((c) => c.kind === 'mesh' && !!c.texture),
  }))

  // The runner's source check: images whose file can no longer be read (and had
  // no copy in project storage to heal from), named in one warning.
  async function checkImageSources() {
    const lost = await imagesStore.probeImageSources()
    if (!lost.length) return null
    const names = lost.slice(0, 3).map((img) => img.name).join(', ') + (lost.length > 3 ? ', …' : '')
    return `${pluralize(lost.length, 'image')} can no longer be read (${names}): the file was moved, `
      + 'renamed or deleted. Re-add the files, or remove those images; stages that read pixels fail for them.'
  }

  async function runAutomatedWorkflowBlock(type, rawSettings, context = {}) {
    const autoPairing = type === 'match-features' && (rawSettings.strategy ?? 'auto') === 'auto'
    const settings = resolveWorkflowSettings(type, rawSettings, {
      useGpu: workflowUseGpu.value,
      memBudgetBytes: workflowMemBudgetBytes.value,
      mergeCell: denseSummary.value?.mergeCell ?? 0,
      ...(autoPairing ? { posedImageCount: posedImageCount?.value ?? 0, video: datasetProfile.value.kind === 'video' } : {}),
    })
    if (autoPairing) log(`Workflow: Match Features pairing is automatic → ${settings.strategy}`, 'info', 'Workflow')
    if (WORKFLOW_BLOCK_BY_ID.get(type)?.tool) return runToolBlock(type, settings, context)
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
    else if (type === 'gen-mesh') result = await runGenerateMesh(meshFromChain(settings, context))
    else if (type === 'texture-mesh') result = await runTextureBlock(settings, context)
    else throw new Error(`Workflow block is not automated: ${type}`)

    if (result?.ok === false || result?.unchanged) return result
    const changed = type === 'detect-features'
      ? targets.every((img) => img.kpStatus === 'done' && (img.kpRev ?? 0) !== before.get(img.uuid))
      : workflowOutputToken(type) !== before
    if (!changed) {
      return { ok: false, cancelled: false, reason: `${WORKFLOW_BLOCK_BY_ID.get(type)?.label ?? type} did not replace its output` }
    }
    // A fresh dense cloud or mesh restarts the cleanup chain from it.
    if (type === 'dense') context.cloudId = workflowOutputToken('dense')?.id ?? null
    if (type === 'gen-mesh') context.meshId = workflowOutputToken('gen-mesh')?.id ?? null
    return { ok: true, cancelled: false }
  }

  // The chain a run's tool blocks work along: the cloud / mesh the previous block of
  // this run produced, else Dense Model's cloud / Build Mesh's mesh, else the newest
  // one. Never the viewer selection, so a replayed chain does not depend on clicks.
  function chainSource(kind, context) {
    const list = clouds.value.filter((c) => c.kind === kind && c.count > 0)
    const id = kind === 'mesh' ? context.meshId : context.cloudId
    return list.find((c) => c.id === id)
      ?? list.find((c) => !c.imported && !c.derived)
      ?? list[list.length - 1] ?? null
  }
  // Build Mesh meshes the chain's cloud when a cleanup block produced one (and it
  // still has normals); otherwise the dialog's own default source.
  function meshFromChain(settings, context) {
    const id = context.cloudId
    return id && meshSources.value.some((s) => s.id === id) ? { ...settings, sourceId: id } : settings
  }

  // Tools-tab edits as blocks (core/workflow.js `tool`): the same request the dialog
  // emits, on the chain's cloud or mesh. The new derived cloud continues the chain.
  async function runToolBlock(type, settings, context) {
    const spec = WORKFLOW_BLOCK_BY_ID.get(type)
    const { kind, mode } = spec.tool
    const source = chainSource(kind === 'mesh' ? 'mesh' : 'dense', context)
    if (!source) return { ok: false, cancelled: false, reason: `${spec.label}: no ${kind === 'mesh' ? 'mesh' : 'dense cloud'} to work on` }
    let request = { settings, sourceIds: [source.id] }
    if (type === 'estimate-normals') request = { ...request, settings: normalsSettings(settings, source) }
    if (type === 'align-icp') {
      const { reference, ...rest } = settings
      const matches = clouds.value.filter((c) => c.id !== source.id && (c.kind === 'dense' || c.kind === 'mesh')
        && c.count > 0 && (c.name ?? '') === reference)
      if (matches.length !== 1) {
        return { ok: false, cancelled: false, reason: matches.length
          ? `${spec.label}: ${matches.length} clouds are named “${reference}” — rename one`
          : `${spec.label}: no cloud or mesh is named “${reference}”` }
      }
      request = { sourceIds: [source.id, matches[0].id], settings: { ...rest, unitLabel: source.imported ? 'file units' : 'model units' } }
    }
    if (type === 'decimate-mesh') {
      const target = settings.targetTriangles ?? Math.round(source.count * settings.targetRatio)
      if (!(target >= 4 && target < source.count)) {
        return { ok: true, cancelled: false, detail: `Kept ${source.name ?? 'the mesh'}: already at or below the target` }
      }
    }
    const suffix = { filter: 'filtered', normals: 'normals', icp: 'aligned', 'mesh-clean': 'cleaned', 'mesh-smooth': 'smoothed', 'mesh-decimate': 'decimated' }[mode]
    const before = new Set(clouds.value.map((c) => c.id))
    const result = await runEditClouds({ ...request, mode, name: `${source.name ?? (kind === 'mesh' ? 'Mesh' : 'Cloud')} (${suffix})` })
    if (result?.ok === false || result?.cancelled) {
      return result?.cancelled ? result : { ok: false, cancelled: false, reason: result?.reason || `${spec.label} produced no result (see the log)` }
    }
    const made = clouds.value.find((c) => !before.has(c.id) && c.kind === source.kind)
    if (!made) return { ok: false, cancelled: false, reason: `${spec.label} produced no result (see the log)` }
    if (kind === 'mesh') context.meshId = made.id
    else context.cloudId = made.id
    return { ok: true, cancelled: false, detail: `${made.name ?? 'Result'}: ${made.count.toLocaleString('en-US')} ${kind === 'mesh' ? 'triangles' : 'points'}` }
  }
  // Estimate Normals' "auto" orientation, as its dialog resolves it: towards the
  // cameras for a computed cloud, up (+Z) for an imported one.
  function normalsSettings({ k, orient }, source) {
    const cameras = mainSparseCloud.value?.cameras ?? new Map()
    const kind = orient === 'auto' ? (!source.imported && cameras.size ? 'cameras' : 'up') : orient
    if (kind === 'cameras' && cameras.size) {
      const points = new Float64Array(cameras.size * 3)
      let i = 0
      for (const cam of cameras.values()) points.set(cameraCenter(cam), 3 * i++)
      return { k, orient: { kind: 'viewpoints', points } }
    }
    if (kind === 'existing') return { k, orient: { kind: 'existing' } }
    return { k, orient: { kind: 'up', up: [0, 0, 1] } }
  }

  // A Quality Gate's value, from the same health snapshot the Quality Report shows.
  // Dense points counts the chain's cloud: after a filter, the filtered one.
  async function measureGateMetric(metric, context = {}) {
    if (!GATE_METRIC_BY_ID.has(metric)) return null
    const counts = {
      sparsePoints: mainSparseCloud.value?.points?.length ?? null,
      densePoints: chainSource('dense', context)?.count ?? null,
    }
    if (metric === 'sparsePoints' || metric === 'densePoints') return gateMetricValue(metric, counts)
    const { rows } = await computeHealth()
    return gateMetricValue(metric, { rows, ...counts })
  }

  // Texture Mesh: the chain's mesh (a cleanup block's output), else Build Mesh's mesh
  // (else the newest untextured one), decimated first when asked and larger than the target.
  async function runTextureBlock({ decimateTo, ...settings }, context = {}) {
    const meshes = clouds.value.filter((c) => c.kind === 'mesh' && c.count > 0 && !c.texture)
    let source = meshes.find((c) => c.id === context.meshId)
      ?? meshes.find((c) => !c.imported && !c.derived) ?? meshes[meshes.length - 1]
    if (!source) return { ok: false, cancelled: false, reason: 'Texture Mesh: no mesh to texture' }
    if (decimateTo > 0 && source.count > decimateTo) {
      const before = new Set(clouds.value.map((c) => c.id))
      const dec = await runEditClouds({ mode: 'mesh-decimate', sourceIds: [source.id],
        settings: { targetTriangles: decimateTo, preserveBoundary: true }, name: `${source.name} (decimated)` })
      if (dec?.ok === false) return dec
      source = clouds.value.find((c) => c.kind === 'mesh' && !before.has(c.id)) ?? source
    }
    return runTextureMesh({ sourceId: source.id, settings, name: `${source.name} (textured)` })
  }

  function workflowOutputToken(type) {
    if (type === 'match-features') return matchRun.value
    if (type === 'reconstruct') return mainSparseCloud.value
    if (type === 'compute-depth') return depthMaps.value
    if (type === 'dense') return clouds.value.find((c) => c.kind === 'dense' && !c.imported && !c.derived) ?? null
    if (type === 'gen-dem') return dem.value
    if (type === 'gen-ortho') return ortho.value
    if (type === 'gen-mesh') return clouds.value.find((c) => c.kind === 'mesh' && !c.imported && !c.derived) ?? null
    if (type === 'texture-mesh') return [...clouds.value].reverse().find((c) => c.kind === 'mesh' && c.texture) ?? null
    return null
  }

  const workflowRunner = useWorkflowRunner({
    state: workflowState,
    runAutomated: runAutomatedWorkflowBlock,
    measure: measureGateMetric,
    cancelAutomated: cancelRun,
    openInteractive,
    recordRun: recordWorkflowRun,
    onLog: log,
    checkSources: checkImageSources,
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
