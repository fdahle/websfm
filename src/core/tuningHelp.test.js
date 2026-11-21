import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTuningHelp, helpParagraphs } from './tuningHelp.js'
import { TUNING_GROUPS, tuningKeys } from './help/consoleSettings.js'

const SAMPLE = `// Not a group.
const x = 1

// The group's introduction.
// ── Not a section of anyone ──
export const DEMO_TUNING = {
  // ── First part ──
  // Help of a,
  // over two lines.
  a: 1,
  b: 2, // b's own, after the value
  // (and its continuation)
  c: 3,
  url: 'https://example.org/x', // after a URL
  // A comment for the solver group.
  solver: {
    tol: 1e-6,
    // The iteration cap.
    iters: 200,
  },
  // ── Second part ──
  d: true,
}

export const OTHER_TUNING = {
  e: 'x',
}
`

describe('parseTuningHelp', () => {
  const r = parseTuningHelp(SAMPLE)
  const k = r.DEMO_TUNING.keys

  it('reads groups, their introduction and each key', () => {
    expect(Object.keys(r)).toEqual(['DEMO_TUNING', 'OTHER_TUNING'])
    expect(r.DEMO_TUNING.intro).toBe("The group's introduction.")
    expect(Object.keys(k)).toEqual(['a', 'b', 'c', 'url', 'solver', 'solver.tol', 'solver.iters', 'd'])
  })

  it('takes the comment above a key, or after its value, as its help', () => {
    expect(k.a).toMatchObject({ help: 'Help of a,\nover two lines.', section: 'First part', sharedWith: null })
    expect(k.b.help).toBe("b's own, after the value (and its continuation)")
    expect(k.url.help).toBe('after a URL')
  })

  it('shares the help of the key before, or of the sub-group, when a key has none', () => {
    expect(k.c).toMatchObject({ help: k.b.help, sharedWith: 'b' })
    expect(k['solver.tol']).toMatchObject({ help: 'A comment for the solver group.', sharedWith: 'solver' })
    expect(k['solver.iters']).toMatchObject({ help: 'The iteration cap.', sharedWith: null })
  })

  it('files keys under the section title above them, and keeps the title out of the help', () => {
    expect(k.d).toMatchObject({ section: 'Second part' })
    expect(k.d.help).toBe('') // nothing is shared across a section title
    expect(Object.values(k).some((v) => v.help.includes('──'))).toBe(false)
  })
})

describe('helpParagraphs', () => {
  it("undoes the source's line wrapping and keeps blank lines as breaks", () => {
    expect(helpParagraphs('One\nsentence.\n\nTwo')).toEqual(['One sentence.', 'Two'])
    expect(helpParagraphs('')).toEqual([])
  })
})

describe('tuning.js as it is', () => {
  const parsed = parseTuningHelp(readFileSync(new URL('./tuning.js', import.meta.url), 'utf8'))

  for (const [group, g] of Object.entries(TUNING_GROUPS)) {
    it(`gives every ${group} knob the console can set its comment as help`, () => {
      const keys = parsed[g.exportName]?.keys ?? {}
      const leaves = Object.keys(keys).filter((k) => !keys[k].group)
      // The parser and the module agree on what the knobs are, so a change to how
      // tuning.js is written fails here, not silently in the dialog.
      expect(leaves.map((k) => `${group}.${k}`)).toEqual(tuningKeys(group))
      const bare = leaves.filter((k) => keys[k].help.length < 10)
      expect(bare).toEqual([])
    })
  }
})
