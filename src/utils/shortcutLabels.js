// The browser side of core/help/shortcuts.js: which platform's key names to show.
// Components write a tooltip as `Undo (${keyLabel('mask.undo')})`.
import { shortcutLabel } from '../core/help/shortcuts.js'

const nav = globalThis.navigator
export const IS_MAC = /Mac|iPhone|iPad/.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || '')

export const keyLabel = (id) => shortcutLabel(id, IS_MAC)
