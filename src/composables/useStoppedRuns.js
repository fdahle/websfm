// A long run a dead tab did not finish (closed, crashed, killed by the browser for
// memory) leaves its journal in the project (core/runJournal.js). When the project
// opens, ask whether to continue it from where it stopped or to discard it.
//
// Injected: `runs` maps a journal's stage to { label, start(settings, { resume }) },
// e.g. depth → runComputeDepthMaps; `isBusy` refuses to start one over another run.
import { chooseDialog } from './useConfirmations.js'
import { useLog } from './useLog.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import * as opfs from '../utils/opfs.js'
import { journalSummary } from '../core/runJournal.js'

export function useStoppedRuns({ runs, isBusy = () => false }) {
  const { log } = useLog()
  const projects = useProjectsStore()

  async function offerStoppedRuns(projectId) {
    let journals
    try {
      journals = await opfs.loadRunJournals(projectId)
    } catch {
      return
    }
    for (const journal of journals) {
      const run = runs[journal.stage]
      if (!run || projects.currentProjectId !== projectId || isBusy()) continue
      const what = journalSummary(journal, run.label)
      log(`Stopped run found: ${what}`, 'warn', 'Project')
      const answer = await chooseDialog({
        title: 'Continue the stopped run?',
        message:
          `${what} The tab running it closed before it finished. Continue it where it stopped, or ` +
          'discard what it saved and start again later?',
        confirmLabel: 'Continue',
        altLabel: 'Discard',
        danger: false,
      })
      if (projects.currentProjectId !== projectId) return
      if (answer === 'confirm') {
        if (isBusy()) {
          log(`${run.label}: not continued — another run is in progress`, 'warn', 'Project')
          continue
        }
        await run.start(journal.settings, { resume: journal })
      } else if (answer === 'alt') {
        await opfs.deleteRunJournal(projectId, journal.stage)
        log(`${run.label}: the stopped run was discarded`, 'info', 'Project')
      }
      // Cancel: ask again next time the project opens.
    }
  }

  return { offerStoppedRuns }
}
