import { computed, ref } from 'vue'
import { blockOutputValid, WORKFLOW_BLOCK_BY_ID, workflowPreflight, workflowTargetIndex } from '../core/workflow.js'
import { evaluateGate } from '../core/workflowGate.js'

// Executes a workflow block by block. Injected: `state` (the semantic readiness the
// preflight checks), `runAutomated(type, settings, context)` (one stage; `context` is
// per run, so a cleanup chain can hand its newest cloud to the next tool), `measure(metric)`
// (a Quality Gate's value, with the same context), `openInteractive(type)` and `recordRun(snapshot)`.
export function useWorkflowRunner({
  state, runAutomated, openInteractive, recordRun,
  cancelAutomated = () => {}, onLog = () => {}, measure = async () => null,
}) {
  const running = ref(false)
  const currentBlockId = ref(null)
  const statuses = ref({})
  const pause = ref(null)
  const startedAt = ref(null)
  let decide = null
  let stopRequested = false

  const paused = computed(() => !!pause.value)

  function setStatus(id, status, detail = '', gate = null) {
    statuses.value = { ...statuses.value, [id]: { status, detail, at: new Date().toISOString(), ...(gate ? { gate } : {}) } }
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
    const blocks = workflow.blocks
    const active = blocks.map((b, i) => b.enabled && i >= fromIndex && (!onlyIds || onlyIds.has(b.id)))
    const nextActive = (i) => { while (i < blocks.length && !active[i]) i++; return i }
    const checks = workflowPreflight(workflow, initial, { fromIndex, onlyIds })
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
    const gates = []
    const context = {}
    // Forward jumps only (preflight refuses the rest): the blocks passed over are
    // recorded as skipped, so the run's snapshot shows which branch ran.
    const jump = (from, target, why) => {
      const to = workflowTargetIndex(workflow, target)
      if (to <= from) throw new Error(`${why}: cannot go to “${target}”`)
      for (let k = from + 1; k < to; k++) if (active[k]) setStatus(blocks[k].id, 'skipped', `${why} went to ${target}`)
      return nextActive(to)
    }
    let jumpTo = null
    try {
      for (let index = nextActive(fromIndex); index < blocks.length; index = jumpTo ?? nextActive(index + 1)) {
        jumpTo = null
        const block = blocks[index]
        if (stopRequested) { outcome = 'stopped'; break }
        const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
        if (!spec) continue
        currentBlockId.value = block.id

        if (block.type === 'goto') {
          jumpTo = jump(index, block.settings.target, spec.label)
          setStatus(block.id, 'completed', `Went to ${block.settings.target}`)
          continue
        }
        if (block.type === 'gate') {
          const s = block.settings
          setStatus(block.id, 'running', 'Measuring')
          let value = null, why = ''
          try { value = await measure(s.metric, context) } catch (err) { why = ` (${err?.message ?? err})` }
          if (stopRequested) { setStatus(block.id, 'stopped'); outcome = 'stopped'; break }
          const result = evaluateGate(s, value)
          const pass = result.outcome === 'pass'
          const target = pass ? (s.passTarget || null) : (s.onFail === 'branch' ? s.failTarget : null)
          const record = {
            blockId: block.id, name: block.name || null, metric: s.metric, op: s.op, threshold: s.threshold,
            value: result.value, outcome: result.outcome, action: pass ? (target ? 'branch' : 'continue') : s.onFail,
            target, at: new Date().toISOString(),
          }
          gates.push(record)
          const message = `${result.message}${why}`
          setStatus(block.id, pass ? 'passed' : 'failed', message, record)
          onLog(`Workflow gate: ${message}`, pass ? 'info' : 'warn', 'Workflow')
          if (pass || s.onFail === 'continue') {
            if (target) jumpTo = jump(index, target, spec.label)
            continue
          }
          if (s.onFail === 'branch') { jumpTo = jump(index, target, spec.label); continue }
          if (s.onFail === 'stop') {
            outcome = 'failed'
            error = `Quality gate failed — ${message}`
            onLog(`Workflow stopped — ${error}`, 'error', 'Workflow')
            break
          }
          const answer = await waitForDecision({ kind: 'gate', blockId: block.id, message })
          record.decision = answer === 'continue' ? 'continue' : 'stop'
          if (answer !== 'continue') { outcome = 'stopped'; break }
          continue
        }

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
        const result = await runAutomated(block.type, { ...block.settings }, context)
        if (stopRequested || result?.cancelled) { setStatus(block.id, 'stopped'); outcome = 'stopped'; break }
        if (result?.ok === false) {
          throw new Error(result.error || result.reason || `${spec.label} did not complete`)
        }
        const after = state.value ?? state()
        if (spec.produces.length && !blockOutputValid(block.type, after)) {
          throw new Error(`${spec.label} finished without producing ${spec.produces.join(', ')}`)
        }
        setStatus(block.id, 'completed', result?.detail ?? '')
      }
    } catch (err) {
      outcome = 'failed'
      error = err?.message ?? String(err)
      if (currentBlockId.value) setStatus(currentBlockId.value, 'failed', error)
      onLog(`Workflow failed — ${error}`, 'error', 'Workflow')
    } finally {
      const finishedAt = new Date().toISOString()
      recordRun({ workflow: JSON.parse(JSON.stringify(workflow)), startedAt: startedAt.value, finishedAt, outcome, error, statuses: statuses.value, gates })
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
