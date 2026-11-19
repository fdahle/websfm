// The evidence a georeference was fitted on, as one string: the georeference is kept
// while the model, the photos, the GCPs and the camera positions are what they were
// (stores/reconstruction/georeferencing.js), and saved with that string.
//
// A record's `imageName` is left out. It is the name the record was imported under; its
// link to a photo is `imageId`, and relinkImageRecord (core/io/nameMatch.js) renames a
// linked record to its photo's name, on reopen or when a photo is renamed. Counting the
// name dropped the georeference of every project placed by a position or marker file
// that names the photos in another case or without the extension, on every reopen.
//
// Only the GCPs the fit can use count (fitGcps): an enabled control point with X, Y
// and Z and marks in two photos. Adding a point, marking it once, typing its name or
// editing a checkpoint changes nothing the fit read, so it keeps the georeference
// (and the DEM and orthophoto built in it).
//
// Pure: plain data in, a string out.

import { isGroundControl } from '../io/gcp.js'
import { precisionFromGcp } from '../gcpAccuracy.js'

const withoutNames = (key, value) => (key === 'imageName' ? undefined : value)

// Fields of a GCP the fit does not read: its name, the status derived from its
// accuracies, and whether a mark was placed by hand or detected (an accepted
// detection stays where it was).
const GCP_UNREAD = new Set(['name', 'accuracyStatus'])
const MARK_UNREAD = new Set(['source', 'score'])
const pick = (record, unread) => Object.fromEntries(Object.entries(record).filter(([k]) => !unread.has(k)))
const marked = (o) => o?.px != null && o?.py != null

/**
 * The GCPs a georeference can be fitted on, with only the fields the fit reads: ground
 * control (core/io/gcp.js isGroundControl, as the fit gates it) marked in two photos or
 * more. Applying it twice gives the same list.
 * @param {object[]|undefined} gcps
 * @returns {object[]|undefined}
 */
export function fitGcps(gcps) {
  if (!Array.isArray(gcps)) return gcps
  return gcps
    .filter((g) => isGroundControl(g, { precision: precisionFromGcp }))
    .filter((g) => (g.observations ?? []).filter(marked).length >= 2)
    .map((g) => ({
      ...pick(g, GCP_UNREAD),
      observations: (g.observations ?? []).filter(marked).map((o) => pick(o, MARK_UNREAD)),
    }))
}

const keyOf = (evidence) =>
  JSON.stringify(
    evidence && 'gcps' in evidence ? { ...evidence, gcps: fitGcps(evidence.gcps) } : evidence,
    withoutNames,
  )

export const georefEvidenceKey = (evidence) => keyOf(evidence)

// A key saved in an older form (with the names, or with every GCP), in the form
// georefEvidenceKey gives now: what that evidence would key as today.
export function currentEvidenceKey(key) {
  if (typeof key !== 'string') return key
  try {
    return keyOf(JSON.parse(key))
  } catch {
    return key
  }
}

// What each part of the evidence is, in the log's words.
const PART_NAMES = {
  crs: 'the project CRS',
  model: 'the sparse model',
  cameras: 'the cameras',
  images: 'the photos',
  gcps: 'the GCPs',
  poses: 'the camera positions',
}

// Changed records named per part, for the debug line that says what moved.
const MAX_EXAMPLES = 3

// The fields (object keys, or array positions) whose values differ between two records.
function changedFields(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
}

// A record's identity in a list: an [id, …] entry (cameras, photos) or a record's id.
const recordKey = (r, i) => (Array.isArray(r) ? String(r[0]) : r && typeof r === 'object' && r.id != null ? r.id : i)

/**
 * What differs between the evidence a georeference was fitted on (`savedKey`) and the
 * evidence now (`nowKey`), both georefEvidenceKey strings, part by part:
 * [{ part, name, added, removed, changed, examples }]; a part that is not a list counts 1
 * changed; `examples` names up to three changed records ({ key, fields }).
 * [] when they are the same; one entry with part 'unreadable' when a key does not parse.
 */
export function evidenceChanges(savedKey, nowKey) {
  let a, b
  try {
    a = JSON.parse(currentEvidenceKey(savedKey))
    b = JSON.parse(nowKey)
  } catch {
    return [{ part: 'unreadable', name: 'the saved evidence', added: 0, removed: 0, changed: 1, examples: [] }]
  }
  const out = []
  for (const part of new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])) {
    const x = a?.[part],
      y = b?.[part]
    if (JSON.stringify(x) === JSON.stringify(y)) continue
    const entry = { part, name: PART_NAMES[part] ?? part, added: 0, removed: 0, changed: 0, examples: [] }
    if (Array.isArray(x) && Array.isArray(y)) {
      const before = new Map(x.map((r, i) => [recordKey(r, i), r]))
      const after = new Map(y.map((r, i) => [recordKey(r, i), r]))
      for (const [k, r] of after) {
        if (!before.has(k)) entry.added++
        else if (JSON.stringify(before.get(k)) !== JSON.stringify(r)) {
          entry.changed++
          if (entry.examples.length < MAX_EXAMPLES)
            entry.examples.push({ key: k, fields: changedFields(before.get(k), r) })
        }
      }
      for (const k of before.keys()) if (!after.has(k)) entry.removed++
    } else entry.changed = 1
    out.push(entry)
  }
  return out
}

/** The changes as words for a log line: "the camera positions (3 edited) and the photos (1 added)". */
export function evidenceChangeText(changes) {
  const parts = changes.map((c) => {
    // A list part counts its records; a single value (the CRS, the model) just changed.
    const list = !['crs', 'model', 'unreadable'].includes(c.part)
    const counts = list
      ? [
          c.added && `${c.added.toLocaleString('en')} added`,
          c.removed && `${c.removed.toLocaleString('en')} removed`,
          c.changed && `${c.changed.toLocaleString('en')} edited`,
        ].filter(Boolean)
      : []
    return counts.length ? `${c.name} (${counts.join(', ')})` : c.name
  })
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : (parts[0] ?? '')
}
