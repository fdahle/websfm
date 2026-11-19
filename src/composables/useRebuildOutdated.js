import { watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useWorkflowsStore } from '../stores/useWorkflowsStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { projectRestoring } from '../stores/projectStores.js'
import { createWorkflow, createWorkflowBlock } from '../core/workflow.js'
import { rebuildPlan, REBUILD_DIALOG } from '../core/rebuildPlan.js'
import { lastDialogSettings } from './useDialogSettings.js'
import { showToast } from './useToasts.js'
import { useLog } from './useLog.js'
import { t } from './useI18n.js'

// Reconstruct ▸ Rebuild Outdated: after a step outdated the products (Optimize Cameras,
// gradual selection, Adjust with GCPs, a refit), a workflow that rebuilds the main ones
// in order (core/rebuildPlan.js), each step from its dialog's last settings in this
// project, opened in the Workflow Builder to check and run. Nothing runs by itself:
// the rebuild can take hours, and the residuals may want a look first.

// The main products that are outdated: [{ id, kind, name, georeferenced }].
export function outdatedMainProducts(recon = useReconstructionStore()) {
  const out = []
  for (const [kind, record] of [
    ['dense', recon.mainDenseCloud],
    ['mesh', recon.mainMeshCloud],
    ['dem', recon.dem],
    ['ortho', recon.ortho],
  ]) {
    if (!record || !recon.productStatus(record).outdated) continue
    out.push({ id: record.id, kind, name: record.name, georeferenced: record.frameStamp?.source === 'georef' })
  }
  return out
}

const WORKFLOW_NAME = 'Rebuild outdated'

// Build the workflow and open it in the Workflow Builder; the one before it, by the
// same name, is replaced. → the block types, [] when nothing is outdated.
export async function openRebuildWorkflow() {
  const recon = useReconstructionStore()
  const workflows = useWorkflowsStore()
  const { log } = useLog()
  const outdated = outdatedMainProducts(recon)
  const types = rebuildPlan({
    outdated,
    depthMaps: recon.depthMapCount,
    georeferenced: !!recon.validGeoref,
  })
  if (!types.length) {
    log('Rebuild Outdated: nothing is outdated', 'info', 'Workflow')
    return []
  }
  const blocks = []
  for (const type of types) {
    const block = createWorkflowBlock(type)
    const op = REBUILD_DIALOG[type]
    if (op) block.settings = await lastDialogSettings(op, block.settings)
    // The outdated outputs exist: a run that reuses valid outputs would skip them.
    block.reusePolicy = 'rerun'
    blocks.push(block)
  }
  const workflow = { ...createWorkflow(WORKFLOW_NAME), blocks }
  for (const w of workflows.workflows.filter((x) => x.name === WORKFLOW_NAME)) workflows.removeWorkflow(w.id)
  workflows.addWorkflow(workflow)
  useModalsStore().workflowBuilderOpen = true
  log(
    `Rebuild Outdated: ${outdated.map((p) => `"${p.name}"`).join(', ')} outdated; a workflow of ` +
      `${types.length.toLocaleString('en')} steps (${types.join(', ')}) is ready in the Workflow Builder`,
    'info',
    'Workflow',
  )
  return types
}

// The offer: when main products become outdated, once, a toast with Rebuild…. Not while
// a run or workflow is busy (a rebuild outdates a DEM on its way), and not for what was
// outdated when the project opened.
export function useRebuildOffer({ busy }) {
  const recon = useReconstructionStore()
  const { workflowBuilderOpen } = storeToRefs(useModalsStore())
  let seen = new Set()
  let wasRestoring = false
  const current = () => new Set(outdatedMainProducts(recon).map((p) => p.id))
  watch(
    [() => [...current()].sort().join('|'), busy, () => projectRestoring.value],
    () => {
      if (projectRestoring.value) {
        wasRestoring = true
        return
      }
      // What was outdated when the project finished opening is known, not news.
      if (wasRestoring) {
        wasRestoring = false
        seen = current()
        return
      }
      if (busy()) return
      const now = current()
      const fresh = [...now].filter((id) => !seen.has(id))
      seen = now
      if (!fresh.length || workflowBuilderOpen.value) return
      const names = outdatedMainProducts(recon).map((p) => p.name)
      showToast(t('rebuild.toast', { n: names.length }), {
        detail: names.join(', '),
        action: t('rebuild.action'),
        ms: 15000,
        onClick: () => openRebuildWorkflow(),
      })
    },
    { flush: 'post' },
  )
}
