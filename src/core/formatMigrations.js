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
import { MOVED_DOCUMENTS } from './projectLayout.js'
import { makeFrameModelResolver, calibrationSnapshot } from './sfm/displayFrame.js'

/** @typedef {{ [path: string]: object | null }} ProjectDocuments */
/**
 * @typedef {object} FormatMigration
 * @property {number} from
 * @property {string} note
 * @property {string[]} documents
 * @property {(docs: ProjectDocuments) => ProjectDocuments} migrate
 */

// Version 1 read omega/phi/kappa as Rx·Ry·Rz from the ground into the photo; from
// version 2 they mean that rotation from the photo onto the ground, as Metashape and
// Pix4D write them (footprint.js opkMatrix). Angles taken from a file were the file's
// own and now read as their author meant; the ones WebSfM worked out from a drone's
// gimbal yaw/pitch/roll were in the old sense, and become the angles of the transposed
// rotation. Self-contained, so a later change to footprint.js cannot change the step.
export function transposedOpk(omega, phi, kappa) {
  if (![omega, phi, kappa].every(Number.isFinite)) return [omega, phi, kappa]
  const d = Math.PI / 180
  const co = Math.cos(omega * d),
    so = Math.sin(omega * d),
    cp = Math.cos(phi * d),
    sp = Math.sin(phi * d),
    ck = Math.cos(kappa * d),
    sk = Math.sin(kappa * d)
  // Rx·Ry·Rz, transposed: row i is column i.
  const M = [
    [cp * ck, co * sk + so * sp * ck, so * sk - co * sp * ck],
    [-cp * sk, co * ck - so * sp * sk, so * ck + co * sp * sk],
    [sp, -so * cp, co * cp],
  ]
  const p = Math.asin(Math.max(-1, Math.min(1, M[0][2])))
  if (Math.abs(Math.cos(p)) < 1e-9) return [omega, phi, kappa]
  return [Math.atan2(-M[1][2], M[2][2]) / d, p / d, Math.atan2(-M[0][1], M[0][0]) / d]
}

/** @type {FormatMigration[]} */
export const FORMAT_MIGRATIONS = [
  {
    from: 1,
    note: 'omega/phi/kappa from drone gimbal angles now follow the Metashape and Pix4D convention',
    documents: ['project.json', 'poses.json'],
    migrate(docs) {
      const project = docs['project.json']
      if (Array.isArray(project?.images)) {
        docs['project.json'] = {
          ...project,
          images: project.images.map((im) => {
            const m = im?.meta
            if (m?.cameraOrientationSource !== 'xmp-gimbal') return im
            const [cameraOmega, cameraPhi, cameraKappa] = transposedOpk(m.cameraOmega, m.cameraPhi, m.cameraKappa)
            return { ...im, meta: { ...m, cameraOmega, cameraPhi, cameraKappa } }
          }),
        }
      }
      const poses = docs['poses.json']
      if (Array.isArray(poses?.poses)) {
        docs['poses.json'] = {
          ...poses,
          poses: poses.poses.map((p) => {
            if (p?.source !== 'exif' || p.orientationSource !== 'xmp-gimbal') return p
            const [omega, phi, kappa] = transposedOpk(p.omega, p.phi, p.kappa)
            const [omegaEnu, phiEnu, kappaEnu] = transposedOpk(p.omegaEnu, p.phiEnu, p.kappaEnu)
            return { ...p, omega, phi, kappa, omegaEnu, phiEnu, kappaEnu }
          }),
        }
      }
      return docs
    },
  },
  {
    from: 2,
    note: 'documents moved into folders: data/ (sensors, GCPs, poses, …), reconstruction/, internal/ (dialog settings)',
    documents: [...Object.keys(MOVED_DOCUMENTS), ...Object.values(MOVED_DOCUMENTS)],
    // The project folder's top keeps only project.json and folders (core/projectLayout.js).
    // The reconstruction's binary files stay where they are: its reader looks in both
    // places, and its next save writes them into reconstruction/.
    migrate(docs) {
      for (const [from, to] of Object.entries(MOVED_DOCUMENTS)) {
        if (docs[from] == null) continue
        if (docs[to] == null) docs[to] = docs[from]
        docs[from] = null
      }
      return docs
    },
  },
  {
    from: 3,
    note: 'each sparse model keeps its own lens (calibration), taken from the last run and the sensors',
    documents: ['project.json', 'data/sensors.json', 'reconstruction/reconstruction.json'],
    // Until now one project-wide run summary and the sensor table gave every model its
    // lens. Each sparse cloud now carries its own (displayFrame.js calibrationSnapshot):
    // here, exactly what that join gave it, so every product reads the same frame model
    // as before (depth maps are reused by it, core/dense/depthReuse.js). The main model's
    // is the run's ('migrated'); another model was drawn with the same join, which was
    // not necessarily its own run's lens ('not-recorded').
    migrate(docs) {
      const recon = docs['reconstruction/reconstruction.json']
      if (!recon?.clouds) return docs
      const sensors = docs['data/sensors.json']?.sensors ?? []
      const sensorOf = new Map((docs['project.json']?.images ?? []).map((im) => [im.uuid, im.sensorId ?? null]))
      const resolve = makeFrameModelResolver({ summary: recon.summary ?? null, sensors })
      const sparse = recon.clouds.filter((c) => c.kind === 'sparse')
      const mainId = sparse.some((c) => c.id === recon.mainSparseId) ? recon.mainSparseId : sparse[0]?.id
      for (const cloud of sparse) {
        if (cloud.calibration) continue
        const images = (cloud.cameras ?? []).map((c) => ({ uuid: c.uuid, sensorId: sensorOf.get(c.uuid) ?? null }))
        cloud.calibration = calibrationSnapshot({
          resolve,
          images,
          source: cloud.id === mainId ? 'migrated' : 'not-recorded',
        })
      }
      return docs
    },
  },
]

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
