import { it, expect } from 'vitest'
import { rememberNewProjectDraft, takeNewProjectDraft } from './newProjectDraft.js'

const DEFAULTS = { name: 'My Project', sceneType: 'aerial', crs: 'EPSG:4326', dirHandle: null }

it('opens on the defaults when nothing failed', () => {
  expect(takeNewProjectDraft(DEFAULTS)).toEqual(DEFAULTS)
})

it('reopens a failed create with what the user typed, once', () => {
  const dir = { name: 'survey' }
  rememberNewProjectDraft({ name: 'Bridge 2026', sceneType: 'aerial', crs: 'EPSG:25832', dirHandle: dir })
  expect(takeNewProjectDraft(DEFAULTS)).toEqual({ name: 'Bridge 2026', sceneType: 'aerial', crs: 'EPSG:25832', dirHandle: dir })
  // Consumed: the next New Project (not a retry) starts fresh.
  expect(takeNewProjectDraft(DEFAULTS)).toEqual(DEFAULTS)
})

it('keeps the picker on a CRS for an object-capture draft', () => {
  rememberNewProjectDraft({ name: 'Vase', sceneType: 'object', crs: null, dirHandle: null })
  expect(takeNewProjectDraft(DEFAULTS)).toEqual({ name: 'Vase', sceneType: 'object', crs: 'EPSG:4326', dirHandle: null })
})

it('forgets the draft when cleared', () => {
  rememberNewProjectDraft({ name: 'X', sceneType: 'aerial', crs: 'EPSG:4326' })
  rememberNewProjectDraft(null)
  expect(takeNewProjectDraft(DEFAULTS)).toEqual(DEFAULTS)
})
