import { describe, it, expect } from 'vitest'
import { NEED_CHECKS, guardReason } from './commands.js'
import { icons } from '../../utils/icons.js'
import {
  TABS, SCENE_GROUP, allGroups, leafCommands, menuReason, stepValue,
} from './ribbonTabs.js'

const leaves = leafCommands(allGroups())

describe('ribbon tables', () => {
  it('only uses prerequisite keys the shared guard table knows', () => {
    for (const cmd of leaves) {
      for (const need of cmd.needs ?? []) expect(NEED_CHECKS, `${cmd.id}: ${need}`).toHaveProperty(need)
    }
  })

  it('has no legacy needsX flags left (the needs array is the one spelling)', () => {
    for (const cmd of leaves) {
      const legacy = Object.keys(cmd).filter((k) => /^needs[A-Z]/.test(k) && k !== 'needsSavedMeasurements')
      expect(legacy, cmd.id).toEqual([])
    }
  })

  it('uses only icons that exist', () => {
    for (const cmd of leaves) expect(icons, `${cmd.id}: ${cmd.icon}`).toHaveProperty(cmd.icon)
    for (const g of allGroups()) for (const c of g.commands) if (c.menu) expect(icons).toHaveProperty(c.icon)
  })

  it('gives every static-tab command a unique id', () => {
    const ids = leafCommands(TABS.flatMap((t) => t.groups)).map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps every menu usable: at least one real row, each row labelled and blurbed', () => {
    for (const g of allGroups()) {
      for (const c of g.commands) {
        if (!c.menu) continue
        const rows = c.menu.filter((m) => !m.section)
        expect(rows.some((r) => !r.disabled), c.id).toBe(true)
        for (const r of rows) {
          expect(r.label, r.id).toBeTruthy()
          expect(r.blurb, r.id).toBeTruthy()
        }
      }
    }
  })
})

describe('menuReason', () => {
  const menu = [{ section: 'A' }, { id: 'a', needs: ['dense'] }, { id: 'b', needs: ['mesh'] }]
  const reasonFor = (state) => (row) => guardReason(row.needs, state)

  it('is empty while any row is usable', () => {
    expect(menuReason(menu, reasonFor({ meshReady: true }))).toBe('')
  })

  it("reports the first row's reason when every row is blocked", () => {
    expect(menuReason(menu, reasonFor({}))).toBe('Build a dense cloud first')
  })
})

describe('stepValue', () => {
  const [points, cams] = SCENE_GROUP.commands.find((c) => c.pair).pair

  it('steps and clamps', () => {
    expect(stepValue(points, 3, 1)).toBe(4)
    expect(stepValue(points, 8, 1)).toBe(8)
    expect(stepValue(points, 1, -1)).toBe(1)
  })

  it('snaps fractional steps without float drift', () => {
    let v = 0.2
    for (let i = 0; i < 4; i++) v = stepValue(cams, v, 1)
    expect(v).toBe(1)
    expect(stepValue(cams, 1.05, 1)).toBe(1.2)
  })

  it('starts from min on a missing value', () => {
    expect(stepValue(points, undefined, 1)).toBe(2)
  })
})

describe('console parity', () => {
  it('every console command dispatches a ribbon command id (or an App-level verb)', async () => {
    const { COMMANDS } = await import('./commands.js')
    const ribbonIds = new Set(leaves.map((c) => c.id))
    // Verbs App.vue handles that are not ribbon buttons.
    const appOnly = new Set(['view-viewer', 'view-map', 'toggle-theme'])
    for (const cmd of COMMANDS) expect(ribbonIds.has(cmd.dispatch) || appOnly.has(cmd.dispatch), cmd.dispatch).toBe(true)
  })
})
