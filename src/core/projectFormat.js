// The saved-project format version, written into project.json as `formatVersion`.
// One number for the whole project (project.json, reconstruction.json, matches,
// products …), checked when a project is opened or imported from a .websfm file.
//
// A change that older projects cannot satisfy raises PROJECT_FORMAT_VERSION and adds its
// step to FORMAT_MIGRATIONS (core/formatMigrations.js); opening an older project then
// migrates it first (utils/opfs/formatMigration.js). PROJECT_FORMAT_MIN rises only at a
// release: a project older than that fails with a clear message instead of whatever
// error its old fields happen to cause. The rules: docs/project-format.md.
//
// Projects saved before the version existed (≤ 0.5.0) have no field and count as 1.
//
// project.json also names the newest WebSfM version that opened it (`newestAppVersion`,
// stamped on opening, so it covers every document that version may have written). An
// older version does not open it, even in the same format: it writes its documents from
// what it knows, so saving would drop what the newer version added. That happens with
// the pinned copies of old releases (core/appVersion.js), which share the projects.
import { isNewerVersion } from './appVersion.js'

export const PROJECT_FORMAT_VERSION = 5
export const PROJECT_FORMAT_MIN = 1

/** The format a project.json was saved in. */
export function projectFormatOf(data) {
  const v = Number(data?.formatVersion ?? 1)
  return Number.isInteger(v) && v >= 1 ? v : null
}

/**
 * Why this version cannot open a project, or null when it can.
 * @param {object} data project.json
 * @param {{ appVersion?: string, pinned?: boolean }} [app] this WebSfM's version, and
 *   whether it is a pinned copy (/v/<version>/) rather than the newest one
 * @returns {string|null}
 */
export function projectFormatProblem(data, { appVersion, pinned = false } = {}) {
  const v = projectFormatOf(data)
  if (v == null) return `project.json has an invalid format version (${data?.formatVersion})`
  const getNewer = pinned
    ? 'Open it in the newest version (the site without /v/… in its address); to work in this version, start a new project from the same images.'
    : 'Reload the page to get the newest version.'
  if (v > PROJECT_FORMAT_VERSION)
    return (
      `This project was saved by a newer version of WebSfM (project format ${v}; this version reads up to ` +
      `${PROJECT_FORMAT_VERSION}). ${getNewer}`
    )
  const newest = data?.newestAppVersion
  if (appVersion && typeof newest === 'string' && isNewerVersion(newest, appVersion))
    return (
      `This project was opened in WebSfM ${newest}, which is newer than this version (${appVersion}); ` +
      `saving it here could lose what ${newest} added. ${getNewer}`
    )
  if (v < PROJECT_FORMAT_MIN)
    return (
      `This project was saved by an older version of WebSfM (project format ${v}), which this version can no ` +
      `longer read: WebSfM is in beta, and its project format still changes. Start a new project from the same images.`
    )
  return null
}

/**
 * project.json with this version stamped as the newest that opened it, or null when it
 * already names this version or a newer one (which projectFormatProblem refuses).
 */
export function stampNewestVersion(data, appVersion) {
  const newest = data?.newestAppVersion
  if (newest === appVersion || (typeof newest === 'string' && isNewerVersion(newest, appVersion))) return null
  return { ...data, newestAppVersion: appVersion }
}
