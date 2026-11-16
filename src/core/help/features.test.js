import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { featureRows, featuresMarkdown } from './features.js'
import { labelText, ribbonEntries } from './ribbonTabs.js'
import { getAllGuideDocs } from './guide.js'

const guides = new Map(getAllGuideDocs().map((d) => [d.id, d]))

describe('docs/features.md', () => {
  it('matches the ribbon and the guide (run `npm run docs:features` after changing either)', () => {
    const onDisk = readFileSync(new URL('../../../docs/features.md', import.meta.url), 'utf8')
    expect(onDisk).toBe(featuresMarkdown(ribbonEntries(), guides))
  })

  it('lists every ribbon command in the row of its place in the ribbon', () => {
    const md = featuresMarkdown(ribbonEntries(), guides)
    const rows = md
      .split('\n')
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Where') && !l.startsWith('| ---'))
      .map((l) => l.split(' | '))
      .map(([where, labels]) => ({ where: where.slice(2), labels }))
    for (const { cmd, path } of ribbonEntries()) {
      // A label may hold commas itself ("Slope, aspect, hillshade…"), so match the cell's text.
      const found = rows.some((r) => r.where === path && r.labels.includes(labelText(cmd)))
      expect(found, `${path} ▸ ${labelText(cmd)}`).toBe(true)
    }
  })
})

describe('featureRows', () => {
  const guide = new Map([['g', { title: 'G', summary: 'What the article covers' }]])
  const entry = (cmd, path = 'Tab ▸ Group') => ({ cmd, tab: 'Tab', path })

  it("prefers a command's own one-liner to its article's summary", () => {
    const rows = featureRows([entry({ id: 'a', label: 'A', guide: 'g', tip: 'Does A' })], guide)
    expect(rows).toEqual([{ path: 'Tab ▸ Group', labels: ['A'], text: 'Does A.', guide: 'g' }])
  })

  it("merges a group's commands that share an article and have no one-liner", () => {
    const rows = featureRows(
      [entry({ id: 'a', label: 'A', guide: 'g' }), entry({ id: 'b', label: 'B', guide: 'g' })],
      guide,
    )
    expect(rows).toEqual([{ path: 'Tab ▸ Group', labels: ['A', 'B'], text: 'What the article covers.', guide: 'g' }])
  })

  it('does not repeat the summary of the row above, nor a label within a row', () => {
    const rows = featureRows(
      [
        entry({ id: 'a', label: 'A', guide: 'g' }, 'Tab ▸ One'),
        entry({ id: 'b', label: 'B', guide: 'g' }, 'Tab ▸ Two'),
        entry({ id: 'c', label: 'B', guide: 'g' }, 'Tab ▸ Two'),
      ],
      guide,
    )
    expect(rows.map((r) => [r.labels, r.text])).toEqual([
      [['A'], 'What the article covers.'],
      [['B'], ''],
    ])
  })

  it('says when a command is limited, and keeps limited commands in rows of their own', () => {
    const rows = featureRows(
      [entry({ id: 'a', label: 'A', aerialOnly: true }), entry({ id: 'b', label: 'B', disabled: true })],
      new Map(),
    )
    expect(rows.map((r) => r.text)).toEqual(['Aerial projects only.', 'Coming soon.'])
  })
})
