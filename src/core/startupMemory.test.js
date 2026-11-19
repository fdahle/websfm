import { describe, it, expect } from 'vitest'
import {
  MAX_REMEMBERED_PROJECTS,
  recalledTabs,
  rememberTabs,
  startupChoice,
  tabId,
  tabsToRemember,
} from './startupMemory.js'

describe('startupChoice', () => {
  const projectIds = ['a', 'b']

  it('asks for a first project when there is none', () => {
    expect(startupChoice({ openLast: true, lastId: 'a', projectIds: [] })).toEqual({ action: 'new' })
  })

  it('opens the last project when asked to', () => {
    expect(startupChoice({ openLast: true, lastId: 'b', projectIds })).toEqual({ action: 'open', id: 'b' })
  })

  it('shows the list when switched off, or the last project is gone or unknown', () => {
    expect(startupChoice({ openLast: false, lastId: 'b', projectIds })).toEqual({ action: 'picker' })
    expect(startupChoice({ openLast: true, lastId: 'deleted', projectIds })).toEqual({ action: 'picker' })
    expect(startupChoice({ openLast: true, lastId: null, projectIds })).toEqual({ action: 'picker' })
  })

  it('never reopens a project whose opening did not finish', () => {
    // The tab died while "a" loaded: opening it again could crash it again.
    expect(startupChoice({ openLast: true, lastId: 'a', projectIds, interruptedId: 'a' })).toEqual({
      action: 'picker',
      reason: 'interrupted',
      id: 'a',
    })
    // An interrupted project since deleted no longer matters.
    expect(startupChoice({ openLast: true, lastId: 'b', projectIds, interruptedId: 'gone' })).toEqual({
      action: 'open',
      id: 'b',
    })
  })
})

describe('tab memory', () => {
  const tabs = [
    { id: 'viewer', type: 'viewer' },
    { id: 'map', type: 'map' },
    { id: 'img:u1', type: 'image', imageId: 'u1', title: 'a.jpg' },
    { id: 'gcp:7', type: 'gcp', gcpId: 7, title: 'GCP 7' },
    { id: 'metadata', type: 'table' },
    { id: 'product:p1', type: 'product', productId: 'p1', productKind: 'dem' },
    { id: 'raster:r1', type: 'raster', rasterId: 'r1' },
  ]

  it('keeps what each tab shows, in order, and which is active', () => {
    const kept = tabsToRemember(tabs, 'gcp:7')
    expect(kept).toEqual({
      tabs: [
        { type: 'image', id: 'u1' },
        { type: 'gcp', id: '7' },
        { type: 'product', id: 'p1' },
        { type: 'raster', id: 'r1' },
      ],
      active: 'gcp:7',
    })
    // Each entry opens as the tab it came from.
    expect(kept.tabs.map(tabId)).toEqual(['img:u1', 'gcp:7', 'product:p1', 'raster:r1'])
  })

  it('falls back to the 3D tab when the active one is not kept', () => {
    expect(tabsToRemember(tabs, 'metadata').active).toBe('viewer')
    expect(tabsToRemember(tabs, 'map').active).toBe('map')
  })

  it('round-trips through storage and drops projects no longer there', () => {
    let all = rememberTabs({}, 'a', tabsToRemember(tabs, 'img:u1'), ['a', 'b'])
    all = rememberTabs(all, 'b', tabsToRemember(tabs.slice(0, 2), 'map'), ['a', 'b'])
    expect(recalledTabs(JSON.parse(JSON.stringify(all)), 'a')).toEqual(tabsToRemember(tabs, 'img:u1'))
    all = rememberTabs(all, 'b', { tabs: [], active: 'viewer' }, ['b'])
    expect(Object.keys(all)).toEqual(['b'])
  })

  it('keeps at most MAX_REMEMBERED_PROJECTS, the most recent', () => {
    const ids = Array.from({ length: MAX_REMEMBERED_PROJECTS + 5 }, (_, i) => `p${i}`)
    let all = {}
    for (const id of ids) all = rememberTabs(all, id, { tabs: [], active: 'viewer' }, ids)
    expect(Object.keys(all)).toHaveLength(MAX_REMEMBERED_PROJECTS)
    expect(Object.keys(all).at(-1)).toBe(ids.at(-1))
    expect(all.p0).toBeUndefined()
  })

  it('reads damaged storage as nothing kept, and skips unknown entries', () => {
    expect(recalledTabs(null, 'a')).toBeNull()
    expect(recalledTabs({ a: { tabs: 'x' } }, 'a')).toBeNull()
    expect(recalledTabs({ a: { tabs: [{ type: 'image', id: 'u1' }, { type: 'weird', id: 'z' }, null] } }, 'a')).toEqual(
      { tabs: [{ type: 'image', id: 'u1' }], active: 'viewer' },
    )
  })
})
