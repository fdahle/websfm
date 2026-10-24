import { reactive, markRaw } from 'vue'
import { getGlossaryEntry } from '../core/help/glossary.js'
import { getGuideDoc, getParam } from '../core/help/guide.js'
import { useGlossaryStore } from '../stores/useGlossaryStore.js'
import { useGuideStore } from '../stores/useGuideStore.js'
import { loadHelpRenderer } from './useHelpHtml.js'
import { matches } from '../core/help/shortcuts.js'

// The one stack of hover help popups (Crusader-Kings-style nested tooltips).
// Hovering a help word on the page (GlossaryTerm, FieldHelp, a link in the
// Glossary/Guide body) opens level 0 and replaces whatever was open. Hovering a
// link inside a pinned popup opens the next level on top and keeps its
// ancestors; hovering another link in a lower popup replaces everything above
// it. Each popup fills its ring for RING_MS, then pins (stays open, becomes
// clickable). An unpinned popup closes when its anchor is left. Pinned popups
// close on a click outside every popup (all of them), on Escape (the top one),
// or when a lower level is replaced. HelpPopupStack.vue renders the stack.

export const RING_MS = 700

// Entries: { uid, anchor, title, render(renderer) → html, readMore(), pinned }
export const helpStack = reactive([])

let uid = 0
let ringTimer = null
let listening = false

/**
 * Open `spec` at `level` (0 = a word on the page, n + 1 = a link inside the
 * popup at level n), closing whatever sits at that level and above.
 */
export function openHelp(level, spec) {
  if (!spec) return
  level = Math.min(level, helpStack.length)
  if (helpStack[level]?.anchor === spec.anchor) return
  truncate(level)
  loadHelpRenderer().catch((error) => console.warn('[help] could not load the help renderer:', error))
  helpStack.push({ ...spec, anchor: markRaw(spec.anchor), uid: ++uid, pinned: false })
  clearTimeout(ringTimer)
  ringTimer = setTimeout(pinTop, RING_MS)
}

/** The pointer left `anchor`: close its popup (and any above) unless pinned. */
export function leaveHelp(anchor) {
  const i = helpStack.findIndex((e) => e.anchor === anchor)
  if (i !== -1 && !helpStack[i].pinned) truncate(i)
}

/** `anchor` is going away (unmount): close its popup and everything above. */
export function dropHelp(anchor) {
  const i = helpStack.findIndex((e) => e.anchor === anchor)
  if (i !== -1) truncate(i)
}

export function closeHelp() {
  truncate(0)
}

function truncate(level) {
  if (level >= helpStack.length) return
  clearTimeout(ringTimer)
  helpStack.splice(level)
  if (!helpStack.length) unlisten()
}

function pinTop() {
  const top = helpStack[helpStack.length - 1]
  if (!top) return
  top.pinned = true
  listen()
}

function listen() {
  if (listening) return
  listening = true
  document.addEventListener('mousedown', onDocMouseDown, true)
  document.addEventListener('keydown', onKeydown, true)
}
function unlisten() {
  if (!listening) return
  listening = false
  document.removeEventListener('mousedown', onDocMouseDown, true)
  document.removeEventListener('keydown', onKeydown, true)
}

function onDocMouseDown(e) {
  if (e.target.closest?.('.glossary-tooltip')) return
  if (helpStack.some((entry) => entry.anchor.contains(e.target))) return
  closeHelp()
}

function onKeydown(e) {
  if (!matches(e, 'app.escape')) return
  // Only this popup layer, not the action modal underneath.
  e.stopPropagation()
  truncate(helpStack.length - 1)
}

// ── What a popup shows ────────────────────────────────────────────────────────
// Glossary and Guide are peer browsers: opening one closes the other instead of
// stacking two same-z-index dialogs (each keeps its tabs for the next visit).
export function openGlossaryTab(id) {
  useGuideStore().close()
  useGlossaryStore().openTerm(id)
}
export function openGuideTab(id, param = null) {
  useGlossaryStore().close()
  useGuideStore().openOp(id, param)
}

export function glossarySpec(id, anchor) {
  const entry = getGlossaryEntry(id)
  if (!entry) return null
  return {
    anchor,
    title: entry.title,
    render: (r) => r.renderHelpMarkdown(entry.summary || '', { selfId: id }),
    readMore: () => openGlossaryTab(id),
  }
}

export function guideSpec(id, anchor) {
  const doc = getGuideDoc(id)
  if (!doc) return null
  return {
    anchor,
    title: doc.title,
    render: (r) => r.renderGuide(doc.summary),
    readMore: () => openGuideTab(id),
  }
}

// A parameter section of a Guide doc. `values` is a getter returning
// { value, defaultValue } (the field's live value and the code default), so the
// popup shows what the modal currently uses; the Guide marker's default text is
// the fallback when the code default isn't passed.
export function paramSpec(op, param, anchor, values = () => ({})) {
  const entry = getParam(op, param)
  if (!entry) return null
  return {
    anchor,
    title: entry.label,
    render: (r) => r.renderGuide(entry.body) + valueLine(values(), entry.defaultText),
    readMore: () => openGuideTab(op, param),
  }
}

function valueLine(values, defaultText) {
  const value = shown(values.value)
  const def = shown(values.defaultValue) ?? defaultText
  const hasDef = def !== null && def !== ''
  if (value !== null && (!hasDef || String(value) !== String(def))) {
    const suffix = hasDef ? ` · default <code>${def}</code>` : ''
    return `<p class="fh-default">Current: <code>${value}</code>${suffix}</p>`
  }
  return hasDef ? `<p class="fh-default">Default: <code>${def}</code></p>` : ''
}

// Checkboxes read as on/off rather than true/false.
function shown(v) {
  if (v === undefined || v === null) return null
  return typeof v === 'boolean' ? (v ? 'on' : 'off') : v
}

// Markdown-rendered cross-links (`help:` → data-help-id, `guide:` → data-guide-id).
export function helpLinkFrom(target) {
  return target?.closest?.('a[data-help-id], a[data-guide-id]') ?? null
}
export function linkSpec(link) {
  return link.dataset.helpId ? glossarySpec(link.dataset.helpId, link) : guideSpec(link.dataset.guideId, link)
}
export function followLink(link) {
  closeHelp()
  if (link.dataset.helpId) openGlossaryTab(link.dataset.helpId)
  else openGuideTab(link.dataset.guideId)
}
