import { pluralize } from '../core/textFormat.js'
import { formatClock } from './timeFormat.js'

// What a long run says to someone who is not looking at it: the tab title while it
// runs, the desktop notification when it ends. Pure, so the wording is tested; the
// browser side is composables/useRunAttention.js.

// A run shorter than this ends before anyone has switched away; notifying about it
// is noise.
export const NOTIFY_MIN_MS = 30_000

// The tab title. `run` is the open progress modal ({ title, percent, indeterminate })
// or null; `waiting` is a paused workflow. With neither, the page's own title.
export function runTabTitle(base, { run = null, waiting = false } = {}) {
  if (waiting) return `Waiting for you · ${base}`
  if (!run) return base
  // The modal caps a running bar at 99%; so does the title.
  const pct = run.indeterminate ? '' : `${Math.min(99, run.percent)}% · `
  return `${pct}${run.title} · ${base}`
}

// The notification for a stage that ended, or null when there should be none.
// `run` is usePipeline's lastRun, `errors` the error lines it logged.
export function stageNotice(run, errors = []) {
  if (!run || run.endedAt - run.startedAt < NOTIFY_MIN_MS) return null
  const took = `after ${formatClock((run.endedAt - run.startedAt) / 1000)}`
  if (run.cancelled) return { title: `${run.title} cancelled`, body: took }
  if (errors.length || !run.ok) {
    return { title: `${run.title} failed`, body: errors[0] ?? `It did not complete, ${took}. See the console.` }
  }
  return { title: `${run.title} finished`, body: took }
}

// The notification for a workflow that ended (useWorkflowRunner's lastOutcome).
export function workflowNotice(outcome) {
  if (!outcome) return null
  const ms = Date.parse(outcome.finishedAt) - Date.parse(outcome.startedAt)
  if (!(ms >= NOTIFY_MIN_MS)) return null
  const took = `after ${formatClock(ms / 1000)}`
  if (outcome.outcome === 'completed') return { title: `Workflow “${outcome.name}” finished`, body: took }
  if (outcome.outcome === 'stopped') return { title: `Workflow “${outcome.name}” stopped`, body: took }
  return { title: `Workflow “${outcome.name}” failed`, body: outcome.error || took }
}

// The toast for a stage that logged errors, or null. Not for a cancelled run: its
// "cancelled" rejections are logged as errors, and the user asked for them.
export function stageErrorToast(run, errors = []) {
  if (!run || run.cancelled || !errors.length) return null
  return {
    title: errors.length === 1 ? `${run.title}: an error` : `${run.title}: ${pluralize(errors.length, 'error')}`,
    detail: errors[0],
  }
}
