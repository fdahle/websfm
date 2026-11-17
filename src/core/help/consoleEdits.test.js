import { describe, it, expect } from 'vitest'
import { EDITS, editCommand, editUsage, findNamed, parseEditArgs, quoteArg } from './consoleEdits.js'
import { splitArgs } from './console.js'
import { getCommand } from './commands.js'

const edit = (noun) => EDITS.find((e) => e.noun === noun)
const LISTS = {
  images: [
    { id: 1, name: 'a.jpg' },
    { id: 2, name: 'b.jpg' },
  ],
  gcps: [
    { id: 'g1', name: 'GCP 1' },
    { id: 'g2', name: 'GCP 2' },
  ],
}
const lists = (l) => LISTS[l]

describe('consoleEdits', () => {
  it('makes every action a command of the Edit group, with a usage line', () => {
    for (const e of EDITS)
      for (const action of Object.keys(e.actions)) {
        const cmd = getCommand(`${e.noun} ${action}`)
        expect(cmd?.group).toBe('Edit')
        expect(cmd.usage).toEqual([editUsage(e, action)])
      }
  })

  it('writes a command the parser reads back to the same objects', () => {
    const line = editCommand('gcp disable', [['GCP 1', 'GCP 2']])
    expect(line).toBe('gcp disable "GCP 1" "GCP 2"')
    const parsed = parseEditArgs(edit('gcp'), 'disable', splitArgs(line).slice(2), lists)
    expect(parsed.args).toEqual([LISTS.gcps])
    expect(quoteArg("it's")).toBe(`"it's"`)
    expect(quoteArg('say "hi"')).toBe(`'say "hi"'`)
  })

  it('ends a long list in … rather than naming every photo', () => {
    const names = Array.from({ length: 20 }, (_, i) => `p${i}.jpg`)
    const line = editCommand('image disable', [names])
    expect(line.split(' ')).toHaveLength(2 + 8 + 1)
    expect(line.endsWith(' …')).toBe(true)
  })

  it('reads numbers, choices and key=value fields', () => {
    expect(parseEditArgs(edit('region'), 'set', ['0', '0', '0', '10', '10', '5'], lists).args).toEqual([
      [0, 0, 0, 10, 10, 5],
    ])
    expect(parseEditArgs(edit('region'), 'set', ['0', '0', 'x', '10', '10', '5'], lists).error).toBe('Give 6 numbers')
    expect(parseEditArgs(edit('gcp'), 'set', ['GCP 1', 'x=12.5', 'z='], lists).args).toEqual([
      LISTS.gcps[0],
      { x: 12.5, z: '' },
    ])
    expect(parseEditArgs(edit('gcp'), 'add', ['New'], lists).args).toEqual(['New', null])
    expect(parseEditArgs(edit('gcp'), 'add', ['New', 'check', 'more'], lists).error).toMatch(/^Too many arguments/)
  })

  it('finds a name exactly, then by its start, then inside it, and says when it is ambiguous', () => {
    const items = [{ name: 'DEM' }, { name: 'DEM 2' }, { name: 'Ortho' }]
    expect(findNamed(items, 'dem', 'product').item).toBe(items[0])
    expect(findNamed(items, 'ort', 'product').item).toBe(items[2])
    expect(findNamed(items, 'em', 'product').error).toMatch(/matches 2 products/)
    expect(findNamed([{ name: 'A' }, { name: 'a' }], 'a', 'GCP').error).toBe('2 of the GCPs are named "a"')
  })
})
