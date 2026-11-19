// What a GCP still needs before the georeference can use it, in one place: the sidebar
// row, the Control & Markers table and the Georeference dialog all say it the same way.
//
// A control point is used when it is enabled, has X, Y and Z, a ground accuracy (σ) on
// each axis, and marks in two photos (core/io/gcp.js isGroundControl adds the role, and
// stores/reconstruction/georeferencing.js qualifyingGcps that the photos are aligned).
// A checkpoint needs the same to be measured. A marker needs only its two marks.
//
// Pure: plain data in, plain data out.

import { normalizeGcpRole } from './io/gcp.js'
import { precisionFromGcp } from './gcpAccuracy.js'

// What can be missing, in the order a user fixes it.
export const READINESS_NEEDS = ['xy', 'z', 'accuracy', 'marks']

const marked = (o) => o?.px != null && o?.py != null

/**
 * @param {object} gcp  a useGcpsStore record
 * @param {{ aligned?: (imageId: *) => boolean }} [opts]  whether a photo is in the model;
 *   without it every marked photo counts
 * @returns {{ role: string, enabled: boolean, ready: boolean, needs: string[], marks: number }}
 *   `needs` lists what is missing (READINESS_NEEDS), `marks` the marks that count
 */
export function gcpReadiness(gcp, { aligned = null } = {}) {
  const role = normalizeGcpRole(gcp?.role)
  const enabled = gcp?.enabled !== false
  const marks = (gcp?.observations ?? []).filter((o) => marked(o) && (!aligned || aligned(o.imageId))).length
  const needs = []
  if (role !== 'marker') {
    if (!Number.isFinite(gcp?.x) || !Number.isFinite(gcp?.y)) needs.push('xy')
    if (!Number.isFinite(gcp?.z)) needs.push('z')
    if (!precisionFromGcp(gcp)) needs.push('accuracy')
  }
  if (marks < 2) needs.push('marks')
  return { role, enabled, ready: enabled && !needs.length, needs, marks }
}

/**
 * The project's GCPs as the Georeference dialog counts them.
 * @returns {{ ready: number, control: number, notReady: { name: string, needs: string[], marks: number }[] }}
 *   `ready` the enabled control points it can use, `control` all enabled control points,
 *   `notReady` the enabled control points it cannot use yet, with why
 */
export function controlReadiness(gcps, opts = {}) {
  let ready = 0,
    control = 0
  const notReady = []
  for (const g of gcps ?? []) {
    const r = gcpReadiness(g, opts)
    if (!r.enabled || r.role !== 'control') continue
    control++
    if (r.ready) ready++
    else notReady.push({ name: g.name, needs: r.needs, marks: r.marks })
  }
  return { ready, control, notReady }
}

// The needs as English words, for log lines and the dialogs whose text is still English
// (the UI renders them from the catalogue, gcps.need.*).
const NEED_WORDS = {
  xy: 'no X/Y',
  z: 'no Z',
  accuracy: 'no accuracy (σ)',
  marks: (n) => `marked in ${n} of 2 photos`,
}
export const needWords = (needs, marks = 0) =>
  needs.map((k) => (typeof NEED_WORDS[k] === 'function' ? NEED_WORDS[k](marks) : NEED_WORDS[k]))

/**
 * Whether the model waits for Georeference to use its GCPs: three or more can be used,
 * and the model is not georeferenced with them (never, by camera positions only, or the
 * fit was dropped because a GCP it used changed).
 * @param {{ usable: boolean, georefMethod: string|null }} s  usable: ≥ 3 GCPs the fit can
 *   use (georeferencing.js canGeoreferenceGcps); georefMethod: the valid fit's, or null
 */
export const gcpsAwaitGeoreference = ({ usable = false, georefMethod = null } = {}) =>
  !!usable && georefMethod !== 'gcps'
