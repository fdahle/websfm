// Every keyboard shortcut and modifier gesture in the app, in one table. It is the
// source for three things that must agree:
//   • the key handlers, which ask `matches(e, id)` instead of testing e.key / e.ctrlKey
//     themselves, so rebinding a shortcut here rebinds it;
//   • the tooltips, which show `shortcutLabel(id)` (utils/shortcutLabels.js picks the
//     platform: Ctrl+Z, or ⌘Z on a Mac);
//   • the Keyboard Shortcuts dialog (Help ▸ Shortcuts, or ?), grouped by context.
//
// A combo is written 'Mod+Shift+Z': `Mod` is Ctrl, or ⌘ on a Mac (either is accepted
// on every platform, as before), then Shift / Alt, then the key as `KeyboardEvent.key`
// names it ('Escape', 'Enter', '[', 'z'). A combo ending in Click or Drag is a mouse
// gesture: listed in the dialog, never matched here (its handler reads the modifier
// from the pointer event, see each entry's `where`).
//
// Plain control behaviour (Enter / Esc in a rename field, arrow keys in a menu, Tab)
// is not a shortcut and is not listed.

export const SHORTCUT_GROUPS = [
  { id: 'app', title: 'Anywhere' },
  { id: 'images', title: 'Image list' },
  { id: 'mask', title: 'Image tab ▸ Mask editing' },
  { id: 'select3d', title: '3D view ▸ Select points' },
  { id: 'measure3d', title: '3D view ▸ Measure' },
  { id: 'region3d', title: '3D view ▸ Region' },
  { id: 'measure2d', title: 'DEM, orthophoto and map ▸ Measure' },
]

const TABLE = [
  // ── Anywhere (App.vue) ──
  { id: 'app.shortcuts', group: 'app', keys: ['?'], does: 'Show this list of shortcuts' },
  { id: 'app.console', group: 'app', keys: ['Mod+`'], does: 'Show or hide the console' },
  { id: 'app.consolePrompt', group: 'app', keys: ['Mod+K'], does: 'Open the console with the cursor in its prompt' },
  {
    id: 'app.escape',
    group: 'app',
    keys: ['Escape'],
    does: 'Close the open dialog, menu or help box; with none open, leave the active tool (mask or point editing, a 3D tool)',
  },

  // ── Image list (sidebar ▸ ImagesSection.vue) ──
  {
    id: 'images.toggle',
    group: 'images',
    keys: ['Mod+Click'],
    does: 'Add an image to the selection, or take it out',
    where: 'ImagesSection',
  },
  {
    id: 'images.range',
    group: 'images',
    keys: ['Shift+Click'],
    does: 'Select every image up to this one',
    where: 'ImagesSection',
  },

  // ── Mask editing (composables/useMaskEditor.js; Escape is App's) ──
  { id: 'mask.brush', group: 'mask', keys: ['B'], does: 'Brush: paint the mask' },
  { id: 'mask.erase', group: 'mask', keys: ['E'], does: 'Eraser: unpaint the mask' },
  { id: 'mask.rect', group: 'mask', keys: ['R'], does: 'Rectangle: mask the dragged box' },
  {
    id: 'mask.rectErase',
    group: 'mask',
    keys: ['Alt+Drag'],
    does: 'Rectangle: erase the dragged box',
    where: 'ViewerImage',
  },
  { id: 'mask.smart', group: 'mask', keys: ['S'], does: 'Smart Select: click an object to segment it' },
  {
    id: 'mask.smartCarve',
    group: 'mask',
    keys: ['Alt+Click'],
    does: 'Smart Select: carve a part away',
    where: 'ViewerImage',
  },
  { id: 'mask.smartAdd', group: 'mask', keys: ['Enter'], does: 'Smart Select: add the preview to the mask' },
  { id: 'mask.smartDiscard', group: 'mask', keys: ['Delete', 'Backspace'], does: 'Smart Select: discard the preview' },
  { id: 'mask.invert', group: 'mask', keys: ['I'], does: 'Invert the mask' },
  { id: 'mask.smaller', group: 'mask', keys: ['['], does: 'Smaller brush' },
  { id: 'mask.larger', group: 'mask', keys: [']'], does: 'Larger brush' },
  { id: 'mask.undo', group: 'mask', keys: ['Mod+Z'], does: 'Undo' },
  { id: 'mask.redo', group: 'mask', keys: ['Mod+Shift+Z', 'Mod+Y'], does: 'Redo' },

  // ── 3D view (Viewer3D.vue, useCloudSelection.js, useRegionGizmo.js) ──
  {
    id: 'select3d.add',
    group: 'select3d',
    keys: ['Shift+Drag'],
    does: 'Add to the selection',
    where: 'useCloudSelection',
  },
  {
    id: 'select3d.subtract',
    group: 'select3d',
    keys: ['Alt+Drag', 'Mod+Drag'],
    does: 'Remove from the selection',
    where: 'useCloudSelection',
  },
  {
    id: 'select3d.clear',
    group: 'select3d',
    keys: ['Escape'],
    does: 'Abandon the shape being drawn, else clear the selection, else leave the tool',
  },
  { id: 'select3d.delete', group: 'select3d', keys: ['Delete', 'Backspace'], does: 'Delete the selected points' },
  { id: 'measure3d.finish', group: 'measure3d', keys: ['Enter'], does: 'Finish the line or area' },
  { id: 'measure3d.undo', group: 'measure3d', keys: ['Backspace', 'Delete'], does: 'Remove the last point' },
  { id: 'measure3d.clear', group: 'measure3d', keys: ['Escape'], does: 'Clear the drawing; again to stop measuring' },
  { id: 'region3d.abort', group: 'region3d', keys: ['Escape'], does: 'During a drag: put the box back' },

  // ── Measuring on a raster or the map (RasterMeasurements.vue) ──
  { id: 'measure2d.finish', group: 'measure2d', keys: ['Enter'], does: 'Finish the line or area' },
  { id: 'measure2d.undo', group: 'measure2d', keys: ['Backspace'], does: 'Remove the last point' },
  { id: 'measure2d.clear', group: 'measure2d', keys: ['Escape'], does: 'Clear the drawing; again to stop measuring' },
  {
    id: 'measure2d.pan',
    group: 'measure2d',
    keys: ['Shift+Drag'],
    does: 'Pan a DEM or orthophoto',
    where: 'ProductViewer',
  },
]

const MODIFIERS = new Set(['Mod', 'Shift', 'Alt'])
const MOUSE = new Set(['Click', 'Drag'])

// 'Mod+Shift+Z' → { mod, shift, alt, key: 'Z', mouse }. Only the last part may be a
// key, so '+' itself cannot be bound (nothing needs it).
export function parseCombo(text) {
  const parts = text.split('+')
  const key = parts.pop()
  for (const p of parts) if (!MODIFIERS.has(p)) throw new Error(`Shortcut "${text}": unknown modifier "${p}"`)
  if (!key) throw new Error(`Shortcut "${text}": no key`)
  return {
    text,
    key,
    mod: parts.includes('Mod'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    mouse: MOUSE.has(key),
  }
}

export const SHORTCUTS = TABLE.map((s) => ({ ...s, combos: s.keys.map(parseCombo) }))
const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]))

export function shortcut(id) {
  const s = BY_ID.get(id)
  if (!s) throw new Error(`Unknown shortcut "${id}"`)
  return s
}

const isLetter = (k) => /^[a-z]$/i.test(k)

function comboMatches(e, c) {
  if (c.mouse || typeof e.key !== 'string') return false
  if (isLetter(c.key) ? e.key.toLowerCase() !== c.key.toLowerCase() : e.key !== c.key) return false
  if (!!(e.ctrlKey || e.metaKey) !== c.mod || !!e.altKey !== c.alt) return false
  // Shift tells a letter's combos apart (Mod+Z / Mod+Shift+Z). A symbol is typed
  // with whatever its layout needs ('?' is Shift+/ or Shift+ß), so Shift is not
  // checked there, nor on a named key.
  return !isLetter(c.key) || !!e.shiftKey === c.shift
}

// Whether keydown `e` is shortcut `id` (any of its combos).
export function matches(e, id) {
  return shortcut(id).combos.some((c) => comboMatches(e, c))
}

const KEY_NAMES = { 'Escape': 'Esc', 'Delete': 'Del', ' ': 'Space' }
const MAC_MODS = { Mod: '⌘', Shift: '⇧', Alt: '⌥' }
const PC_MODS = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt' }

// The keycaps of one combo, as the dialog draws them: ['Ctrl', 'Shift', 'Z'].
export function comboKeys(c, mac = false) {
  const mods = mac ? MAC_MODS : PC_MODS
  const out = []
  if (c.mod) out.push(mods.Mod)
  if (c.shift) out.push(mods.Shift)
  if (c.alt) out.push(mods.Alt)
  out.push(KEY_NAMES[c.key] ?? (isLetter(c.key) ? c.key.toUpperCase() : c.key))
  return out
}

// A combo as text for a tooltip: 'Ctrl+Shift+Z', or '⌘⇧Z' on a Mac.
export function comboLabel(c, mac = false) {
  const keys = comboKeys(c, mac)
  if (!mac) return keys.join('+')
  const last = keys.pop()
  return keys.join('') + (keys.length && last.length > 1 ? '+' : '') + last
}

// The first combo of shortcut `id`, for a tooltip ("Undo (Ctrl+Z)").
export function shortcutLabel(id, mac = false) {
  return comboLabel(shortcut(id).combos[0], mac)
}

// The dialog's rows: the groups in order, each with its shortcuts, filtered by a
// search text against what a shortcut does and its keys.
export function shortcutSections(query = '', mac = false) {
  const q = query.trim().toLowerCase()
  const hit = (s) =>
    !q ||
    s.does.toLowerCase().includes(q) ||
    s.combos.some((c) => comboLabel(c, mac).toLowerCase().includes(q) || c.text.toLowerCase().includes(q))
  return SHORTCUT_GROUPS.map((g) => ({
    ...g,
    shortcuts: SHORTCUTS.filter((s) => s.group === g.id && hit(s)).map((s) => ({
      id: s.id,
      does: s.does,
      combos: s.combos.map((c) => ({ keys: comboKeys(c, mac), mouse: c.mouse })),
    })),
  })).filter((g) => g.shortcuts.length)
}
