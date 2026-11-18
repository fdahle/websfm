// Which WebSfM a page is: the newest release at the site's root, or the pinned copy of
// a release at /v/<version>/, which stays as it is when the site moves on
// (docs/deployment.md ▸ Pinned versions). All of them share the origin, so they share
// the projects; a project saved by a newer version is not opened by an older one
// (projectFormat.js), since saving it there would drop what the newer one added.
import { compareVersions } from './help/changelog.js'

const PINNED_BASE = /^\/v\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/$/

/** The version a build is pinned to, from its base URL (`/v/0.9.0/`), or null. */
export function pinnedVersionOf(baseUrl) {
  return PINNED_BASE.exec(baseUrl ?? '')?.[1] ?? null
}

/** The URL of a version's pinned copy on this site. */
export const pinnedUrl = (version) => `/v/${version}/`

/** Whether `a` is a later version than `b`; false when either is not a version. */
export function isNewerVersion(a, b) {
  try {
    return compareVersions(a, b) > 0
  } catch {
    return false
  }
}

/**
 * The pinned versions to offer, from /v/versions.json ({ versions: newest first }),
 * without the one running. Null when the list is not a list (no pinned versions here).
 */
export function otherVersions(json, current) {
  const list = json?.versions
  if (!Array.isArray(list)) return null
  return list.filter((v) => typeof v === 'string' && pinnedVersionOf(pinnedUrl(v)) && v !== current)
}
