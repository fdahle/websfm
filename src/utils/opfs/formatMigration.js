// Brings a project saved in an older format up to this version's
// (core/formatMigrations.js) when it is opened, in its own storage: browser storage or
// the user's folder.
//
// Restart-safe. Before it changes anything it writes `format-migration.json`, listing
// the documents the project had, and a copy of each as `<name>.v<from>.bak`. project.json
// is written last, with the new version. A tab that dies partway leaves the old version
// in project.json, so the next open runs the migration again, from the copies and the
// list rather than from the half-migrated documents. The copies stay afterwards, so a bad
// migration can still be undone by hand.
import { trackPersistence, persistenceLock, ignoreMissing } from '../persistence.js'
import { getProjectDir, readJson, writeJson } from './base.js'
import { PROJECT_FORMAT_VERSION, projectFormatOf } from '../../core/projectFormat.js'
import {
  FORMAT_MIGRATIONS,
  applyMigrations,
  changedDocuments,
  migrationPlan,
  planDocuments,
  splitDocumentPath,
} from '../../core/formatMigrations.js'

const STATE = 'format-migration.json'
const backupName = (name, from) => `${name}.v${from}.bak`
const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name)

async function dirAt(root, rel, create = false) {
  let dir = root
  for (const part of rel ? rel.split('/') : []) dir = await dir.getDirectoryHandle(part, { create })
  return dir
}

async function dirOrNull(root, rel) {
  try {
    return await dirAt(root, rel)
  } catch (error) {
    ignoreMissing(error)
    return null
  }
}

// The documents the plan names, its `dir/*.json` patterns expanded over the folder. A
// document an earlier, interrupted run deleted still has its copy, which names it.
async function expandDocuments(root, patterns, from) {
  const paths = new Set()
  const suffix = backupName('', from) // '.v<from>.bak'
  for (const pattern of patterns) {
    const { dir, name, pattern: isPattern } = splitDocumentPath(pattern)
    if (!isPattern) {
      paths.add(joinPath(dir, name))
      continue
    }
    const handle = await dirOrNull(root, dir)
    if (!handle?.keys) continue
    for await (const n of handle.keys()) {
      if (!dir && n === STATE) continue
      if (n.endsWith('.json')) paths.add(joinPath(dir, n))
      else if (n.endsWith('.json' + suffix)) paths.add(joinPath(dir, n.slice(0, -suffix.length)))
    }
  }
  return [...paths]
}

/**
 * Migrate the project's documents from the version in `data` (its project.json) to
 * PROJECT_FORMAT_VERSION. Returns the new project.json and one note per step; a project
 * already in this version comes back unchanged with no notes.
 * @param {string} projectId
 * @param {object} data project.json as read
 * @param {{ steps?: import('../../core/formatMigrations.js').FormatMigration[], to?: number }} [opts]
 * @returns {Promise<{ data: object, notes: string[] }>}
 */
export async function migrateProjectFormat(
  projectId,
  data,
  { steps = FORMAT_MIGRATIONS, to = PROJECT_FORMAT_VERSION } = {},
) {
  const from = projectFormatOf(data)
  if (from == null) throw new Error(`project.json has an invalid format version (${data?.formatVersion})`)
  const plan = migrationPlan(from, to, steps)
  if (!plan.length) return { data, notes: [] }
  return trackPersistence('migrateProjectFormat:' + String(projectId), () =>
    persistenceLock(`project:${projectId}`, async () => {
      const root = await getProjectDir(projectId)
      const state = await readJson(root, STATE)
      const resumed = state?.from === from && Array.isArray(state.present)
      const paths = await expandDocuments(root, planDocuments(plan), from)
      if (resumed) for (const p of state.present) if (!paths.includes(p)) paths.push(p)

      // The documents as they were before any migration touched them.
      const docs = {}
      for (const path of paths) {
        const { dir, name } = splitDocumentPath(path)
        const handle = await dirOrNull(root, dir)
        if (resumed && !state.present.includes(path)) {
          docs[path] = null // created by the interrupted run
          continue
        }
        const kept = handle ? await readJson(handle, backupName(name, from)) : null
        docs[path] = kept ?? (handle ? await readJson(handle, name) : null)
      }
      if (!docs['project.json']) throw new Error('project.json is missing or unreadable')
      const present = paths.filter((p) => docs[p] != null)

      // Nothing is rewritten before the list and every copy are on disk.
      if (!resumed) await writeJson(root, STATE, { from, to, present, startedAt: new Date().toISOString() })
      for (const path of present) {
        const { dir, name } = splitDocumentPath(path)
        const handle = await dirAt(root, dir)
        if ((await readJson(handle, backupName(name, from))) == null)
          await writeJson(handle, backupName(name, from), docs[path])
      }

      const { docs: next, notes } = applyMigrations(docs, plan)
      for (const path of changedDocuments(docs, next)) {
        if (path === 'project.json') continue
        const { dir, name } = splitDocumentPath(path)
        if (next[path] == null) {
          const handle = await dirOrNull(root, dir)
          if (handle) await handle.removeEntry(name).catch(ignoreMissing)
        } else {
          await writeJson(await dirAt(root, dir, true), name, next[path])
        }
      }
      await writeJson(root, 'project.json', next['project.json'])
      await root.removeEntry(STATE).catch(ignoreMissing)
      return { data: next['project.json'], notes }
    }),
  )
}
