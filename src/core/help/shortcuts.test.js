import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  parseCombo,
  matches,
  comboLabel,
  shortcutLabel,
  shortcutSections,
} from './shortcuts.js'

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods })

// Every .js / .vue file under src/, outside the WASM bindings.
function sources(dir = 'src') {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return p.endsWith('wasm') ? [] : sources(p)
    return /\.(js|vue)$/.test(name) && !name.includes('.test.') ? [p] : []
  })
}

describe('shortcut table', () => {
  it('gives every shortcut a unique id, a known group and a description', () => {
    const groups = new Set(SHORTCUT_GROUPS.map((g) => g.id))
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length)
    for (const s of SHORTCUTS) {
      expect(groups.has(s.group), s.id).toBe(true)
      expect(s.does.length, s.id).toBeGreaterThan(3)
      expect(s.combos.length, s.id).toBeGreaterThan(0)
    }
  })

  it('binds no combo twice within one context', () => {
    for (const g of SHORTCUT_GROUPS) {
      const seen = new Map()
      for (const s of SHORTCUTS.filter((x) => x.group === g.id))
        for (const c of s.combos) {
          const k = comboLabel(c).toLowerCase()
          expect(seen.get(k), `${k} in ${g.id}`).toBeUndefined()
          seen.set(k, s.id)
        }
    }
  })

  it('names the handler of every mouse gesture, which a key handler cannot match', () => {
    for (const s of SHORTCUTS.filter((x) => x.combos.some((c) => c.mouse))) expect(s.where, s.id).toBeTruthy()
  })

  // The table is the bindings: a key the dialog lists that no handler asks for would
  // be a promise the app does not keep, and an id a handler asks for must exist.
  it('is used by the handlers: every key shortcut matched somewhere, every id used exists', () => {
    const text = sources()
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n')
    const matched = new Set([...text.matchAll(/matches\(\s*\w+,\s*'([\w.]+)'/g)].map((m) => m[1]))
    const used = new Set(
      [...text.matchAll(/(?:matches\(\s*\w+,|shortcutLabel\(|keyLabel\()\s*'([\w.]+)'/g)].map((m) => m[1]),
    )
    const ids = new Set(SHORTCUTS.map((s) => s.id))
    for (const id of used) expect(ids.has(id), `unknown shortcut ${id}`).toBe(true)
    for (const s of SHORTCUTS.filter((x) => !x.combos.every((c) => c.mouse)))
      expect(matched.has(s.id), `${s.id} is listed but no handler matches it`).toBe(true)
  })
})

describe('parseCombo', () => {
  it('reads modifiers and the key', () => {
    expect(parseCombo('Mod+Shift+Z')).toMatchObject({ key: 'Z', mod: true, shift: true, alt: false, mouse: false })
    expect(parseCombo('Alt+Drag')).toMatchObject({ key: 'Drag', alt: true, mouse: true })
    expect(parseCombo('?')).toMatchObject({ key: '?', mod: false })
  })
  it('rejects an unknown modifier', () => {
    expect(() => parseCombo('Ctrl+Z')).toThrow(/unknown modifier/)
  })
})

describe('matches', () => {
  it('takes Ctrl or ⌘ for Mod, and tells Shift apart on a letter', () => {
    expect(matches(key('z', { ctrlKey: true }), 'mask.undo')).toBe(true)
    expect(matches(key('z', { metaKey: true }), 'mask.undo')).toBe(true)
    expect(matches(key('Z', { ctrlKey: true, shiftKey: true }), 'mask.undo')).toBe(false)
    expect(matches(key('Z', { ctrlKey: true, shiftKey: true }), 'mask.redo')).toBe(true)
    expect(matches(key('y', { ctrlKey: true }), 'mask.redo')).toBe(true)
    expect(matches(key('z'), 'mask.undo')).toBe(false)
  })
  it('does not take a plain letter with Ctrl or Alt held', () => {
    expect(matches(key('b'), 'mask.brush')).toBe(true)
    expect(matches(key('b', { ctrlKey: true }), 'mask.brush')).toBe(false)
    expect(matches(key('b', { altKey: true }), 'mask.brush')).toBe(false)
  })
  it('ignores the Shift a symbol needs', () => {
    expect(matches(key('?', { shiftKey: true }), 'app.shortcuts')).toBe(true)
    expect(matches(key('k', { ctrlKey: true, shiftKey: true }), 'app.consolePrompt')).toBe(false)
  })
  it('matches any of several combos, and never a mouse gesture', () => {
    expect(matches(key('Delete'), 'select3d.delete')).toBe(true)
    expect(matches(key('Backspace'), 'select3d.delete')).toBe(true)
    expect(matches(key('Drag', { shiftKey: true }), 'select3d.add')).toBe(false)
  })
  it('throws on an unknown id', () => {
    expect(() => matches(key('x'), 'nope')).toThrow(/Unknown shortcut/)
  })
})

describe('labels', () => {
  it('spells a combo per platform', () => {
    expect(shortcutLabel('mask.redo')).toBe('Ctrl+Shift+Z')
    expect(shortcutLabel('mask.redo', true)).toBe('⌘⇧Z')
    expect(shortcutLabel('app.escape')).toBe('Esc')
    expect(shortcutLabel('mask.smartDiscard')).toBe('Del')
    expect(shortcutLabel('select3d.subtract', true)).toBe('⌥+Drag')
  })
})

describe('shortcutSections', () => {
  it('lists every group in order with its shortcuts', () => {
    const all = shortcutSections()
    expect(all.map((g) => g.id)).toEqual(SHORTCUT_GROUPS.map((g) => g.id))
    expect(all.flatMap((g) => g.shortcuts).length).toBe(SHORTCUTS.length)
  })
  it('filters by what a shortcut does or by its keys, dropping empty groups', () => {
    const undo = shortcutSections('undo')
    expect(undo.map((g) => g.id)).toEqual(['mask'])
    const ctrl = shortcutSections('ctrl+z')
    expect(ctrl.flatMap((g) => g.shortcuts.map((s) => s.id))).toEqual(['mask.undo'])
    expect(shortcutSections('zzzz')).toEqual([])
  })
})
