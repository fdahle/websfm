import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  parseChangelog,
  firstSentence,
  compareVersions,
  bumpVersion,
  latestRelease,
  countNewEntries,
  cutRelease,
  entryCount,
  UNRELEASED,
} from './changelog.js'

const SAMPLE = `# Changelog

Preamble.

## [Unreleased]

### Added
- **Shortcuts in one list.** Press ? to see them. Tooltips spell keys per
  platform.
- A plain entry without a headline. It has a second sentence.

## [0.2.0] — 2026-10-12 — Tiles and more

### Fixed
- **A fix.** It works now.
  - with a nested point

## [0.1.0-beta.1] — 2026-08-10

First public beta.

- Runs entirely in the browser.
`

describe('parseChangelog', () => {
  const rel = parseChangelog(SAMPLE)

  it('reads releases newest first, with date, title and intro', () => {
    expect(rel.map((r) => r.version)).toEqual([UNRELEASED, '0.2.0', '0.1.0-beta.1'])
    expect(rel[0].date).toBeNull()
    expect(rel[1]).toMatchObject({ date: '2026-10-12', title: 'Tiles and more' })
    expect(rel[2].intro).toBe('First public beta.')
  })

  it('splits entries into headline, summary and full markdown', () => {
    const [a, b] = rel[0].sections[0].entries
    expect(rel[0].sections[0].title).toBe('Added')
    expect(a.headline).toBe('Shortcuts in one list.')
    expect(a.summary).toBe('**Shortcuts in one list.** Press ? to see them.')
    expect(a.markdown).toBe('**Shortcuts in one list.** Press ? to see them. Tooltips spell keys per\nplatform.')
    expect(b.headline).toBe('A plain entry without a headline.')
    expect(b.summary).toBe(b.headline)
  })

  it('keeps nested lines in their entry, and takes entries without a section', () => {
    expect(rel[1].sections[0].entries[0].markdown).toBe('**A fix.** It works now.\n- with a nested point')
    expect(rel[2].sections).toEqual([
      { title: null, entries: [expect.objectContaining({ headline: 'Runs entirely in the browser.' })] },
    ])
    expect(entryCount(rel[0])).toBe(2)
  })
})

describe('firstSentence', () => {
  it('stops at a full stop before a capital, not inside an abbreviation', () => {
    expect(firstSentence('One thing, e.g. this. Two.')).toBe('One thing, e.g. this.')
    expect(firstSentence('Only one')).toBe('Only one')
    expect(firstSentence('Ends at 0.7 m. **Bold** next')).toBe('Ends at 0.7 m.')
    expect(firstSentence('Open it (**New here? Open the example**) or not. Next.')).toBe(
      'Open it (**New here? Open the example**) or not.',
    )
  })
})

describe('versions', () => {
  it('orders numbers, pre-releases and Unreleased', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0-beta.1', '0.1.0')).toBeLessThan(0)
    expect(compareVersions('0.1.0-beta.2', '0.1.0-beta.10')).toBeLessThan(0)
    expect(compareVersions(UNRELEASED, '9.9.9')).toBeGreaterThan(0)
  })
  it('bumps by kind or takes an exact newer version', () => {
    expect(bumpVersion('0.4.0')).toBe('0.5.0')
    expect(bumpVersion('0.4.0', 'patch')).toBe('0.4.1')
    expect(bumpVersion('0.4.2', 'major')).toBe('1.0.0')
    expect(bumpVersion('0.1.0-beta.1', 'minor')).toBe('0.2.0')
    expect(bumpVersion('0.4.0', '1.0.0')).toBe('1.0.0')
    expect(() => bumpVersion('0.4.0', '0.3.0')).toThrow(/not newer/)
  })
  it('counts entries released after the version a user last saw', () => {
    const rel = parseChangelog(SAMPLE)
    expect(latestRelease(rel)).toBe('0.2.0')
    expect(countNewEntries(rel, '0.1.0-beta.1')).toBe(1) // Unreleased never counts
    expect(countNewEntries(rel, '0.2.0')).toBe(0)
    expect(countNewEntries(rel, null)).toBe(0)
  })
})

describe('cutRelease', () => {
  it('moves Unreleased under the new version and leaves an empty Unreleased', () => {
    const out = cutRelease(SAMPLE, '0.3.0', '2026-10-24')
    const rel = parseChangelog(out)
    expect(rel.map((r) => r.version)).toEqual([UNRELEASED, '0.3.0', '0.2.0', '0.1.0-beta.1'])
    expect(entryCount(rel[0])).toBe(0)
    expect(rel[1].date).toBe('2026-10-24')
    expect(entryCount(rel[1])).toBe(2)
    expect(out).toContain('## [Unreleased]\n\n## [0.3.0] — 2026-10-24\n\n### Added\n')
  })
  it('refuses an empty Unreleased or a version already released', () => {
    expect(() => cutRelease(cutRelease(SAMPLE, '0.3.0', 'd'), '0.4.0', 'd')).toThrow(/Nothing to release/)
    expect(() => cutRelease(SAMPLE, '0.2.0', 'd')).toThrow(/already/)
  })
})

describe('CHANGELOG.md', () => {
  const md = readFileSync('CHANGELOG.md', 'utf8')
  const rel = parseChangelog(md)

  it('parses, with Unreleased first and every release dated', () => {
    expect(rel[0].version).toBe(UNRELEASED)
    for (const r of rel.slice(1)) expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    for (let i = 2; i < rel.length; i++) expect(compareVersions(rel[i - 1].version, rel[i].version)).toBeGreaterThan(0)
  })

  it('names the version package.json has as its newest release', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(latestRelease(rel)).toBe(pkg.version)
  })

  it('uses only the Keep a Changelog section names', () => {
    const known = new Set(['Added', 'Changed', 'Performance', 'Fixed', 'Removed', 'Deprecated', 'Security', null])
    for (const r of rel) for (const s of r.sections) expect(known.has(s.title), `${r.version}: ${s.title}`).toBe(true)
  })
})
