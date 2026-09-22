import { computed, ref } from 'vue'
import { blockOutputValid, WORKFLOW_BLOCK_BY_ID, workflowPreflight } from '../core/workflow.js'

export function useWorkflowRunner({
  state, runAutomated, openInteractive, recordRun,
  cancelAutomated = () => {}, onLog = () => {},
}) {
  const running = ref(false)
  const currentBlockId = ref(null)
  const statuses = ref({})
  const pause = ref(null)
  const startedAt = ref(null)
  let decide = null
  let stopRequested = false

  const paused = computed(() => !!pause.value)

  function setStatus(id, status, detail = '') {
    statuses.value = { ...statuses.value, [id]: { status, detail, at: new Date().toISOString() } }
  }

  function waitForDecision(value) {
    pause.value = value
    return new Promise((resolve) => { decide = resolve })
  }

  function respond(action) {
    const resolve = decide
    decide = null
    pause.value = null
    resolve?.(action)
  }

  function stop() {
    stopRequested = true
    if (decide) respond('stop')
    else if (running.value) cancelAutomated()
  }

  async function start(workflow, { fromIndex = 0, onlyIds = null } = {}) {
    // `running` also covers preflight warning decisions. Without taking the lock
    // before awaiting that decision, a second click can replace `decide` and leave
    // the first start() promise unresolved forever.
    if (running.value || pause.value) return false
    running.value = true
    stopRequested = false
    statuses.value = {}
    startedAt.value = new Date().toISOString()
    const initial = state.value ?? state()
    const executionWorkflow = {
      ...workflow,
      blocks: workflow.blocks.slice(fromIndex).filter((b) => b.enabled && (!onlyIds || onlyIds.has(b.id))),
    }
    const checks = workflowPreflight(executionWorkflow, initial)
    const errors = checks.filter((x) => x.level === 'error')
    if (errors.length) {
      pause.value = { kind: 'blocked', message: errors[0].message }
      running.value = false
      return false
    }
    const warnings = checks.filter((x) => x.level === 'warning').map((warning) => {
      const block = workflow.blocks.find((b) => b.id === warning.blockId)
      const policy = block?.warningPolicy && block.warningPolicy !== 'inherit'
        ? block.warningPolicy : workflow.defaults.warningPolicy
      return { ...warning, policy }
    })
    const stoppingWarning = warnings.find((x) => x.policy === 'stop')
    if (stoppingWarning) {
      pause.value = { kind: 'blocked', message: stoppingWarning.message }
      running.value = false
      return false
    }
    const pausingWarnings = warnings.filter((x) => x.policy === 'pause')
    if (pausingWarnings.length) {
      const answer = await waitForDecision({ kind: 'warning', message: pausingWarnings.map((x) => x.message).join(' · ') })
      if (answer !== 'continue') { running.value = false; return false }
    }
    let outcome = 'completed'
    let error = null
    const blocks = workflow.blocks
    try {
      for (let index = fromIndex; index < blocks.length; index++) {
        const block = blocks[index]
        if (!block.enabled) continue
        if (onlyIds && !onlyIds.has(block.id)) continue
        if (stopRequested) { outcome = 'stopped'; break }
        const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
        if (!spec) continue
        currentBlockId.value = block.id
        const live = state.value ?? state()
        const reuse = block.reusePolicy === 'inherit' ? workflow.defaults.reusePolicy : block.reusePolicy
        if (blockOutputValid(block.type, live)) {
          if (reuse === 'valid') {
            setStatus(block.id, 'reused', 'Valid existing output')
            continue
          }
          if (reuse === 'ask') {
            setStatus(block.id, 'paused', 'Existing output is valid')
            const answer = await waitForDecision({ kind: 'reuse', blockId: block.id, message: `${spec.label} already has valid output.` })
            if (answer === 'stop') { outcome = 'stopped'; break }
            if (answer === 'reuse') { setStatus(block.id, 'reused', 'User chose existing output'); continue }
          }
        }

        if (!spec.automated) {
          setStatus(block.id, 'waiting', 'Complete the opened command, then continue')
          openInteractive(block.type)
          const answer = await waitForDecision({ kind: 'interactive', blockId: block.id, message: `${spec.label} needs your input.` })
          if (answer !== 'continue') { outcome = 'stopped'; break }
          setStatus(block.id, 'completed', 'Confirmed by user')
          continue
        }

        setStatus(block.id, 'running')
        onLog(`Workflow: ${spec.label} started`, 'info', 'Workflow')
        const result = await runAutomated(block.type, { ...block.settings })
        if (stopRequested || result?.cancelled) { setStatus(block.id, 'stopped'); outcome = 'stopped'; break }
        if (result?.ok === false) {
          throw new Error(result.error || result.reason || `${spec.label} did not complete`)
        }
        const after = state.value ?? state()
        if (spec.produces.length && !blockOutputValid(block.type, after)) {
          throw new Error(`${spec.label} finished without producing ${spec.produces.join(', ')}`)
        }
        setStatus(block.id, 'completed')
      }
    } catch (err) {
      outcome = 'failed'
      error = err?.message ?? String(err)
      if (currentBlockId.value) setStatus(currentBlockId.value, 'failed', error)
      onLog(`Workflow failed — ${error}`, 'error', 'Workflow')
    } finally {
      const finishedAt = new Date().toISOString()
      recordRun({ workflow: JSON.parse(JSON.stringify(workflow)), startedAt: startedAt.value, finishedAt, outcome, error, statuses: statuses.value })
      currentBlockId.value = null
      running.value = false
      pause.value = null
      decide = null
      if (outcome === 'completed') onLog(`Workflow complete: ${workflow.name}`, 'success', 'Workflow')
    }
    return outcome === 'completed'
  }

  return { running, paused, pause, currentBlockId, statuses, start, respond, stop }
}
