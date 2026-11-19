import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  PORTABLE_KEYS,
  RESET_KEYS,
  STORED_KEYS,
  mergeDialogPresets,
  mergeTemplates,
  readSettingsFile,
  settingsExport,
} from './preferences.js'

const SRC = new URL('..', import.meta.url).pathname

function sourceFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) sourceFiles(p, out)
    else if (/\.(js|vue)$/.test(e.name) && !e.name.endsWith('.test.js')) out.push(p)
  }
  return out
}

// The keys the code keeps in localStorage: string literals handed to it, and the
// `…KEY = '…'` constants of a file that uses it.
function keysInCode() {
  const keys = new Map()
  for (const file of sourceFiles(SRC)) {
    const code = readFileSync(file, 'utf8')
    if (!/localStorage\.(get|set|remove)Item/.test(code)) continue
    const add = (k) => keys.set(k, file.slice(SRC.length))
    for (const m of code.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*'([^']+)'/g)) add(m[1])
    for (const m of code.matchAll(/const\s+\w*KEY\w*\s*=\s*'([^']+)'/g)) add(m[1])
  }
  return keys
}
// Keys the scan finds that are not localStorage entries of their own.
const NOT_STORED = new Set([
  // Kept in sessionStorage; the file removes an old localStorage copy.
  'imageViewToggles',
])

describe('stored keys', () => {
  it('lists every key the code keeps in localStorage, and none it no longer uses', () => {
    const found = keysInCode()
    const unlisted = [...found]
      .filter(([k]) => !(k in STORED_KEYS) && !NOT_STORED.has(k))
      .map(([k, f]) => `${k} (${f})`)
    expect(unlisted).toEqual([])
    expect(Object.keys(STORED_KEYS).filter((k) => !found.has(k))).toEqual([])
  })

  it('resets the preferences and the layout, and exports only what fits another computer', () => {
    expect(RESET_KEYS).toContain('theme')
    expect(RESET_KEYS).toContain('sidebarWidth')
    expect(RESET_KEYS).toContain('websfm.dense.memBudgetGb')
    expect(RESET_KEYS).not.toContain('websfm.ui.lastProject')
    expect(RESET_KEYS).not.toContain('websfm-workflow-templates-v1')
    expect(PORTABLE_KEYS).not.toContain('websfm.dense.memBudgetGb')
    expect(PORTABLE_KEYS).not.toContain('sidebarWidth')
  })
})

describe('settings file', () => {
  const stored = { 'theme': 'dark', 'websfm.dense.memBudgetGb': '24', 'sidebarWidth': '300', 'gridZ': null }
  const dialogPresets = { 'dense-cloud': [{ name: 'Fast', settings: { quality: 'low' } }] }
  const workflowTemplates = [{ id: 't1', name: 'Survey', blocks: [] }]

  it('round-trips the portable preferences, the presets and the templates', () => {
    const file = JSON.parse(
      JSON.stringify(settingsExport({ stored, dialogPresets, workflowTemplates, appVersion: '0.9.0' })),
    )
    expect(file.preferences).toEqual({ theme: 'dark' })
    expect(readSettingsFile(file)).toEqual({ preferences: { theme: 'dark' }, dialogPresets, workflowTemplates })
  })

  it('never takes this computer’s limits or an unknown key from a file', () => {
    const file = settingsExport({ stored: { theme: 'light' } })
    file.preferences['websfm.dense.memBudgetGb'] = '64'
    file.preferences['somethingElse'] = 'x'
    file.preferences['gridZ'] = 3
    expect(readSettingsFile(file).preferences).toEqual({ theme: 'light' })
  })

  it('refuses a file that is not a WebSfM settings file, or a newer one', () => {
    expect(readSettingsFile(null)).toEqual({ error: 'settings.transfer.notSettings' })
    expect(readSettingsFile({ app: 'WebSfM', kind: 'project', version: 1 })).toEqual({
      error: 'settings.transfer.notSettings',
    })
    expect(readSettingsFile({ app: 'WebSfM', kind: 'settings', version: 2 })).toEqual({
      error: 'settings.transfer.newer',
    })
  })

  it('merges presets by dialog and name, keeping the others, sorted', () => {
    const current = {
      'dense-cloud': [
        { name: 'Fast', settings: { quality: 'medium' } },
        { name: 'Mine', settings: { a: 1 } },
      ],
      'dem': [{ name: 'Fine', settings: { gsd: 0.05 } }],
    }
    const merged = mergeDialogPresets(current, {
      'dense-cloud': [
        { name: 'Fast', settings: { quality: 'low' } },
        { name: 'Alpha', settings: {} },
      ],
      'mesh': [{ name: 'Big', settings: { depth: 12 } }, { name: 'broken' }],
    })
    expect(merged['dense-cloud'].map((p) => [p.name, p.settings])).toEqual([
      ['Alpha', {}],
      ['Fast', { quality: 'low' }],
      ['Mine', { a: 1 }],
    ])
    expect(merged.dem).toEqual(current.dem)
    expect(merged.mesh).toEqual([{ name: 'Big', settings: { depth: 12 } }])
  })

  it('merges workflow templates by name', () => {
    const merged = mergeTemplates(
      [
        { id: 'a', name: 'Survey' },
        { id: 'b', name: 'Object' },
      ],
      [{ id: 'c', name: 'Survey' }, { id: 'd', name: 'Film' }, { nameless: true }],
    )
    expect(merged.map((t) => t.id)).toEqual(['c', 'b', 'd'])
  })
})
