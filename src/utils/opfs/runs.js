// Run journals (core/runJournal.js): `runs/<stage>.json`, one per long stage while it
// runs. A journal left in a project is a run a dead tab did not finish.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { getProjectDir, getSubDir, readJson, writeJson } from './base.js'

// The folder without creating it: opening a project must not add an empty runs/.
const runsDir = async (projectId) => (await getProjectDir(projectId)).getDirectoryHandle('runs')

const nameOf = (stage) => {
  if (!/^[a-z][a-z0-9-]*$/.test(String(stage))) throw new Error(`invalid run stage "${stage}"`)
  return `${stage}.json`
}

export async function saveRunJournal(projectId, journal) {
  return trackPersistence('saveRunJournal:' + String(projectId), async () => {
    const dir = await getSubDir(projectId, 'runs')
    await writeJson(dir, nameOf(journal.stage), journal)
  })
}

export async function loadRunJournal(projectId, stage) {
  try {
    return await readJson(await runsDir(projectId), nameOf(stage))
  } catch {
    return null
  }
}

// Every journal in the project: the runs that stopped without finishing.
export async function loadRunJournals(projectId) {
  const out = []
  try {
    const dir = await runsDir(projectId)
    for await (const name of dir.keys()) {
      if (!name.endsWith('.json')) continue
      const j = await readJson(dir, name)
      if (j?.stage && `${j.stage}.json` === name) out.push(j)
    }
  } catch {
    return []
  }
  return out
}

export async function deleteRunJournal(projectId, stage) {
  return trackPersistence('deleteRunJournal:' + String(projectId), async () => {
    try {
      const dir = await runsDir(projectId)
      await dir.removeEntry(nameOf(stage))
    } catch (error) {
      ignoreMissing(error)
    }
  })
}
