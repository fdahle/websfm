// This build of WebSfM: its version, and whether it is the pinned copy of a release
// (/v/<version>/, core/appVersion.js) rather than the newest one at the site's root.
import { version } from '../../package.json'
import { pinnedVersionOf } from '../core/appVersion.js'

export const APP_VERSION = version
export const PINNED = pinnedVersionOf(import.meta.env.BASE_URL) != null

/** What projectFormatProblem needs to know about this build. */
export const APP_BUILD = { appVersion: APP_VERSION, pinned: PINNED }
