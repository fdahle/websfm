// Format migrations: how a saved project of one format version (core/projectFormat.js)
// becomes the next. Pure: a step takes the parsed JSON documents it names and returns
// them changed. The storage layer (utils/opfs/formatMigration.js) reads them, keeps a
// copy of each before it rewrites it, and writes project.json, with the new version,
// last.
//
// Only a change that older projects cannot satisfy needs a step: a renamed or moved
// field, a new structure, a value whose meaning changed. A field added with a safe
// meaning when absent is read with that default instead, and changes no version.
//
// A step:
//   {
//     from: 1,                        // the version it reads; it writes from + 1
//     note: 'GCP marks moved into …', // one line for the project's log
//     documents: ['project.json', 'reconstruction.json', 'products/*.json'],
//     migrate(docs) { … },            // docs: { [path]: object | null } → the same, changed
//   }
// `documents` are paths in the project folder; `dir/*.json` names every JSON document in
// that folder. A path the project does not have is null in `docs`; a step may create it
// (an object) or delete it (null). project.json is always among the documents.
//
// Binary files (depth planes, octree nodes, rasters, keypoints) are never rewritten by a
// step. A change to one of them either reads both layouts, or its step drops the
// product's record so the product is computed again.

import { PROJECT_FORMAT_MIN, PROJECT_FORMAT_VERSION } from './projectFormat.js'

/** @typedef {{ [path: string]: object | null }} ProjectDocuments */
/**
 * @typedef {object} FormatMigration
 * @property {number} from
 * @property {string} note
 * @property {string[]} documents
 * @property {(docs: ProjectDocuments) => ProjectDocuments} migrate
 */

/** @type {FormatMigration[]} */
export const FORMAT_MIGRATIONS = []

/**
 * The steps from version `from` to `to`, in order. Throws when one is missing: a
 * version raised without its migration must fail loudly, not open half-read.
 * @param {number} from
 * @param {number} [to]
 * @param {FormatMigration[]} [steps]
 * @returns {FormatMigration[]}
 */
export function migrationPlan(from, to = PROJECT_FORMAT_VERSION, steps = FORMAT_MIGRATIONS) {
  const plan = []
  for (let v = from; v < to; v++) {
    const step = steps.find((s) => s.from === v)
    if (!step) throw new Error(`no format migration from version ${v} to ${v + 1}`)
    plan.push(step)
  }
  return plan
}

/**
 * Every document path or pattern the plan reads, project.json first.
 * @param {FormatMigration[]} plan
 * @returns {string[]}
 */
export function planDocuments(plan) {
  const all = new Set(['project.json'])
  for (const step of plan) for (const p of step.documents) all.add(p)
  return [...all]
}

/**
 * `dir/*.json` → { dir, pattern: true }; a plain path → { dir, name }.
 * @param {string} path
 */
export function splitDocumentPath(path) {
  const parts = String(path).split('/')
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error(`unsafe document path "${path}"`)
  const name = parts.pop()
  const dir = parts.join('/')
  if (name === '*.json') return { dir, name: null, pattern: true }
  if (name.includes('*')) throw new Error(`unsupported document pattern "${path}" (only dir/*.json)`)
  return { dir, name, pattern: false }
}

/**
 * Whether `path` is one of the documents `pattern` names.
 * @param {string} pattern
 * @param {string} path
 */
export function documentMatches(pattern, path) {
  if (pattern === path) return true
  const p = splitDocumentPath(pattern)
  if (!p.pattern) return false
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? '' : path.slice(0, slash)
  return dir === p.dir && path.endsWith('.json') && !path.slice(slash + 1).includes('/')
}

/**
 * Run the plan over the documents. The input is not changed. After each step,
 * project.json carries that step's target version.
 * @param {ProjectDocuments} docs
 * @param {FormatMigration[]} plan
 * @returns {{ docs: ProjectDocuments, notes: string[] }}
 */
export function applyMigrations(docs, plan) {
  let out = structuredClone(docs)
  const notes = []
  for (const step of plan) {
    const project = out['project.json']
    if (!project) throw new Error('format migration needs project.json')
    if (Number(project.formatVersion ?? 1) !== step.from) {
      throw new Error(`format migration from ${step.from} got a version ${project.formatVersion ?? 1} project`)
    }
    // A step sees only the documents it named (and project.json); the rest pass through.
    const named = Object.fromEntries(
      Object.entries(out).filter(
        ([path]) => path === 'project.json' || step.documents.some((d) => documentMatches(d, path)),
      ),
    )
    const result = step.migrate(named)
    if (!result || typeof result !== 'object') throw new Error(`format migration from ${step.from} returned nothing`)
    out = { ...out, ...result }
    if (!out['project.json']) throw new Error(`format migration from ${step.from} removed project.json`)
    out['project.json'] = { ...out['project.json'], formatVersion: step.from + 1 }
    notes.push(`format ${step.from} → ${step.from + 1}: ${step.note}`)
  }
  return { docs: out, notes }
}

/**
 * The paths whose content the migration changed (created, rewritten or deleted).
 * @param {ProjectDocuments} before
 * @param {ProjectDocuments} after
 * @returns {string[]}
 */
export function changedDocuments(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...paths].filter((p) => JSON.stringify(before[p] ?? null) !== JSON.stringify(after[p] ?? null))
}

/**
 * Whether every version a project can still be opened from has its step: the table
 * covers PROJECT_FORMAT_MIN → PROJECT_FORMAT_VERSION. (A unit test asserts it.)
 * @param {FormatMigration[]} [steps]
 */
export function migrationsComplete(steps = FORMAT_MIGRATIONS) {
  try {
    migrationPlan(PROJECT_FORMAT_MIN, PROJECT_FORMAT_VERSION, steps)
    return true
  } catch {
    return false
  }
}
