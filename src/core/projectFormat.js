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

export const PROJECT_FORMAT_VERSION = 1
export const PROJECT_FORMAT_MIN = 1

/** The format a project.json was saved in. */
export function projectFormatOf(data) {
  const v = Number(data?.formatVersion ?? 1)
  return Number.isInteger(v) && v >= 1 ? v : null
}

/**
 * Why this version cannot open a project, or null when it can.
 * @param {object} data project.json
 * @returns {string|null}
 */
export function projectFormatProblem(data) {
  const v = projectFormatOf(data)
  if (v == null) return `project.json has an invalid format version (${data?.formatVersion})`
  if (v > PROJECT_FORMAT_VERSION)
    return (
      `This project was saved by a newer version of WebSfM (project format ${v}; this version reads up to ` +
      `${PROJECT_FORMAT_VERSION}). Reload the page to get the newest version.`
    )
  if (v < PROJECT_FORMAT_MIN)
    return (
      `This project was saved by an older version of WebSfM (project format ${v}), which this version can no ` +
      `longer read: WebSfM is in beta, and its project format still changes. Start a new project from the same images.`
    )
  return null
}
