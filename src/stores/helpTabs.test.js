import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { helpTabActions } from './helpTabs.js'

function setup(ids, active) {
  const tabs = ref([...ids])
  const activeId = ref(active)
  const actions = helpTabActions({ tabs, activeId, setActive: (id) => (activeId.value = id) })
  return { tabs, activeId, ...actions }
}

describe('helpTabActions', () => {
  it('moves a tab after a target to its right and before one to its left', () => {
    const s = setup(['a', 'b', 'c', 'd'], 'a')
    s.moveTab('a', 'c')
    expect(s.tabs.value).toEqual(['b', 'c', 'a', 'd'])
    s.moveTab('d', 'b')
    expect(s.tabs.value).toEqual(['d', 'b', 'c', 'a'])
    s.moveTab('d', 'd')
    s.moveTab('x', 'b')
    expect(s.tabs.value).toEqual(['d', 'b', 'c', 'a'])
  })

  it('closes the others, or those to one side, and keeps a surviving active tab', () => {
    const s = setup(['a', 'b', 'c', 'd'], 'c')
    s.closeTabsToRight('b')
    expect(s.tabs.value).toEqual(['a', 'b'])
    expect(s.activeId.value).toBe('b') // the active tab was closed
    const t = setup(['a', 'b', 'c', 'd'], 'd')
    t.closeTabsToLeft('c')
    expect(t.tabs.value).toEqual(['c', 'd'])
    expect(t.activeId.value).toBe('d')
    t.closeOtherTabs('c')
    expect(t.tabs.value).toEqual(['c'])
    expect(t.activeId.value).toBe('c')
  })

  it('leaves Home active, and returns to it when every tab closes', () => {
    const s = setup(['a', 'b'], 'home')
    s.closeOtherTabs('a')
    expect(s.activeId.value).toBe('home')
    s.closeAllTabs()
    expect(s.tabs.value).toEqual([])
    expect(s.activeId.value).toBe('home')
  })
})
