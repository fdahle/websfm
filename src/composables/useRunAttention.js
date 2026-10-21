import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useLog } from './useLog.js'
import { useUiSettings } from './useUiSettings.js'
import { showToast } from './useToasts.js'
import { runTabTitle, stageNotice, workflowNotice, stageErrorToast } from '../utils/runAttention.js'

// A long run in a browser tab, for someone who has stopped watching it:
//   • a screen wake lock while a stage or workflow runs (Settings ▸ General), so the
//     display does not sleep mid-run. The browser drops it while the tab is hidden and
//     it is taken again when the tab comes back;
//   • the stage and its percent in the tab title, and "Waiting for you" while a
//     workflow is paused on a question;
//   • a desktop notification when a run of 30 s or more ends, or a workflow pauses,
//     while the tab is hidden (opt-in: it needs the browser's permission);
//   • a toast when a stage logged errors. A failing stage otherwise only closes its
//     progress bar, and the reason is a line in the console. Clicking it opens the console.
//
// Injected: usePipeline's progress state and lastRun, the workflow runner's running /
// pause / lastOutcome, and `openConsole()`.
export function useRunAttention({
  progressOpen,
  progressTitle,
  progressPercent,
  progressIndeterminate,
  lastRun,
  workflowRunning,
  workflowPause,
  workflowOutcome,
  openConsole,
}) {
  const { keepAwake, notifyWhenDone } = useUiSettings()
  const busy = () => progressOpen.value || workflowRunning.value

  // ── Wake lock ──────────────────────────────────────────────────────────────
  let lock = null
  let requesting = false
  async function holdLock() {
    if (lock || requesting || !navigator.wakeLock || document.visibilityState !== 'visible') return
    requesting = true
    try {
      lock = await navigator.wakeLock.request('screen')
      lock.addEventListener('release', () => {
        lock = null
      })
      // The run may have ended while the request was pending.
      if (!(busy() && keepAwake.value)) releaseLock()
    } catch {
      // Refused (battery saver, a policy): the run goes on, the screen may sleep.
    } finally {
      requesting = false
    }
  }
  function releaseLock() {
    const held = lock
    lock = null
    held?.release().catch(() => {})
  }
  function syncLock() {
    if (busy() && keepAwake.value) holdLock()
    else releaseLock()
  }
  watch([progressOpen, workflowRunning, keepAwake], syncLock)

  // ── Tab title ──────────────────────────────────────────────────────────────
  let baseTitle = ''
  function syncTitle() {
    const run = progressOpen.value
      ? { title: progressTitle.value, percent: progressPercent.value, indeterminate: progressIndeterminate.value }
      : null
    const next = runTabTitle(baseTitle, { run, waiting: !!workflowPause.value && workflowRunning.value })
    if (document.title !== next) document.title = next
  }
  watch(
    [progressOpen, progressTitle, progressPercent, progressIndeterminate, workflowPause, workflowRunning],
    syncTitle,
  )

  // ── Errors logged during a stage ───────────────────────────────────────────
  const { entries, onLog } = useLog()
  let runErrors = []
  // Sync: a stage may log before a deferred watcher would run, and that line belongs to it.
  watch(
    progressOpen,
    (open) => {
      if (open) runErrors = []
    },
    { flush: 'sync' },
  )
  const stopListening = onLog(() => {
    if (!progressOpen.value) return
    const entry = entries.value[entries.value.length - 1]
    if (entry?.level === 'error') runErrors.push(entry.message)
  })

  // ── Notifications ──────────────────────────────────────────────────────────
  function notify(notice) {
    if (!notice || !notifyWhenDone.value || document.visibilityState === 'visible') return
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    try {
      const n = new Notification(notice.title, { body: notice.body, tag: 'websfm-run' })
      n.onclick = () => {
        window.focus()
        n.close()
      }
    } catch {
      // Some platforms only allow notifications from a service worker; skip.
    }
  }

  watch(lastRun, (run) => {
    const errors = runErrors
    runErrors = []
    const toast = stageErrorToast(run, errors)
    if (toast) {
      showToast(toast.title, {
        detail: toast.detail,
        kind: 'error',
        ms: 10_000,
        onClick: openConsole,
        action: 'Open the console',
      })
    }
    // Inside a workflow, the workflow's own end is the one worth a notification.
    if (!workflowRunning.value) notify(stageNotice(run, errors))
  })
  watch(workflowOutcome, (outcome) => notify(workflowNotice(outcome)))
  watch(workflowPause, (pause) => {
    if (pause && workflowRunning.value) notify({ title: 'A workflow is waiting for you', body: pause.message ?? '' })
  })

  function onVisibility() {
    if (document.visibilityState === 'visible') syncLock()
  }
  onMounted(() => {
    baseTitle = document.title
    document.addEventListener('visibilitychange', onVisibility)
    syncLock()
    syncTitle()
  })
  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    stopListening()
    releaseLock()
    document.title = baseTitle
  })
}
