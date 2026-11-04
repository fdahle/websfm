// Run journals (core/runJournal.js): `internal/runs/<stage>.json`, one per long stage
// while it runs. A journal left in a project is a run a dead tab did not finish. Before
// format version 3 they were in `runs/` at the folder's top, which is still read, so a
// run stopped by an older version can continue.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { getProjectDir, readJson, writeJson } from './base.js'
import { INTERNAL_DIR, RUNS_DIR } from '../../core/projectLayout.js'

// The folders without creating them: opening a project must not add an empty runs/.
const runsDir = async (projectId) =>
  (await (await getProjectDir(projectId)).getDirectoryHandle(INTERNAL_DIR)).getDirectoryHandle(RUNS_DIR)
const legacyRunsDir = async (projectId) => (await getProjectDir(projectId)).getDirectoryHandle(RUNS_DIR)
const dirsOf = async (projectId) => {
  const out = []
  for (const get of [runsDir, legacyRunsDir]) {
    try {
      out.push(await get(projectId))
    } catch (error) {
      ignoreMissing(error)
    }
  }
  return out
}

const nameOf = (stage) => {
  if (!/^[a-z][a-z0-9-]*$/.test(String(stage))) throw new Error(`invalid run stage "${stage}"`)
  return `${stage}.json`
}

export async function saveRunJournal(projectId, journal) {
  return trackPersistence('saveRunJournal:' + String(projectId), async () => {
    const internal = await (await getProjectDir(projectId, true)).getDirectoryHandle(INTERNAL_DIR, { create: true })
    const dir = await internal.getDirectoryHandle(RUNS_DIR, { create: true })
    await writeJson(dir, nameOf(journal.stage), journal)
  })
}

export async function loadRunJournal(projectId, stage) {
  for (const dir of await dirsOf(projectId)) {
    const j = await readJson(dir, nameOf(stage))
    if (j) return j
  }
  return null
}

// Every journal in the project: the runs that stopped without finishing.
export async function loadRunJournals(projectId) {
  const out = []
  const stages = new Set()
  for (const dir of await dirsOf(projectId)) {
    try {
      for await (const name of dir.keys()) {
        if (!name.endsWith('.json')) continue
        const j = await readJson(dir, name)
        if (j?.stage && `${j.stage}.json` === name && !stages.has(j.stage)) {
          stages.add(j.stage)
          out.push(j)
        }
      }
    } catch {
      /* an unreadable folder holds no journal */
    }
  }
  return out
}

export async function deleteRunJournal(projectId, stage) {
  return trackPersistence('deleteRunJournal:' + String(projectId), async () => {
    for (const dir of await dirsOf(projectId)) await dir.removeEntry(nameOf(stage)).catch(ignoreMissing)
  })
}
