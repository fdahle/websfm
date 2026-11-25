import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseTuningHelp, helpParagraphs } from './tuningHelp.js'
import { TUNING_GROUPS, tuningKeys } from './help/consoleSettings.js'

// What the shown help (the first paragraph of each comment in tuning.js) and the section
// titles must not hold, by AGENTS.md ▸ "Never name a test dataset, a bench number or a
// date in the app": that is the evidence, which goes below the empty `//` line. The set
// names come from scripts/bench/suites/gate.json, the bench configs and the test-data README.
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?'
const EVIDENCE = [
  [
    'a date',
    new RegExp(
      `\\b\\d{4}-\\d{2}(?:-\\d{2})?\\b|\\b\\d{1,2}-\\d{1,2}\\b(?= run| bench)|\\b${MONTH} \\d{1,2}\\b|\\b\\d{1,2} ${MONTH}(?: \\d{4})?\\b|\\b(?:19|20)\\d{2}\\b`,
    ),
  ],
  [
    'a test set',
    new RegExp(
      [
        'south building',
        '\\bSB\\b',
        'quarry',
        'PUTI',
        'GeoScan',
        'Aukerman',
        'ETH3D',
        'courtyard',
        'delivery[ _]area',
        '\\boffice\\b',
        '\\bpipes\\b',
        'playground',
        'terrace',
        'Casa Grande',
        'Iceland',
        '\\bTMA\\b',
        'Mill ?19',
        'Strecha',
        'fountain',
        'Herz-?Jesu',
        'castle-P',
        'entry-P',
        'UseGeo',
        'Mavic',
        'St\\.? Nazaire',
        '\\beagle\\b',
        "building(?:'s)? (?:run|set|bench)",
        '\\bon building\\b',
        'FIORD',
        '\\bBAL\\b',
        'final-\\d',
        'Starbuck',
        'Jorum',
        'Rachel',
        'Crane',
        'Flask',
        'Mapple',
        'Melville',
        'Pequod',
        'Stubb',
        'CA\\d{4}',
        'CA…V',
        'KH-?9 ?[mp]c',
        'synthetic',
        'example (?:set|project|block)',
      ].join('|'),
      'i',
    ),
  ],
  [
    'a bench, plan or note reference',
    /\bbench|HANDOVER|TODO|\bplan[- ]|baselines|dev\/|\bB-[a-z]|\b[A-Z]{2,4}-\d{2}\b|\b(?:WS|[A-Z])\d{1,2}(?:\.\d)?\b(?!\.\d)/,
  ],
  ['a before/after number', /\d[\d.,]*\s*(?:%|px|cm|mm|m|s|MB)?\s*(?:→|->)\s*[\d−-]/],
  ['a commit hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
  ['a code file', /\b[\w/.-]+\.(?:js|mjs|rs|vue|md)\b/],
  ['a release number', /\b(?:in|since|before|until) (?:v?\d+\.\d+(?:\.\d+)?)\b/],
]

/** The rules a shown text breaks, as ['a date: "2026-07-10"', …]. */
function evidenceIn(text) {
  const out = []
  for (const [what, re] of EVIDENCE) {
    const m = re.exec(text)
    if (m) out.push(`${what}: "${m[0]}"`)
  }
  return out
}

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
  // The help of e.
  //
  // Its evidence: measured on a test set, 1.0 → 0.9.
  e: 5,
  f: 6, // f's help, on its line
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
    expect(Object.keys(k)).toEqual(['a', 'b', 'c', 'url', 'solver', 'solver.tol', 'solver.iters', 'd', 'e', 'f'])
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

  it("keeps a comment's evidence, after its first empty line, out of the help", () => {
    expect(k.e).toMatchObject({ help: 'The help of e.', sharedWith: null })
    expect(k.f).toMatchObject({ help: "f's help, on its line", sharedWith: null })
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

    it(`shows ${group} help and section titles a user may read: no dataset, bench number, date or plan`, () => {
      expect(evidenceInGroup(group, parsed[g.exportName]?.keys ?? {})).toEqual([])
    })
  }

  // Groups the dialog does not show (yet), whose comments are written to the same rule.
  for (const exportName of ['DETECT_TUNING']) {
    it(`keeps the help of ${exportName} free of evidence too`, () => {
      const keys = parsed[exportName]?.keys ?? {}
      expect(Object.keys(keys).length).toBeGreaterThan(0)
      expect(Object.keys(keys).filter((k) => keys[k].help.length < 10)).toEqual([])
      expect(evidenceInGroup(exportName, keys)).toEqual([])
    })
  }
})

// Every piece of evidence in a group's shown help and section titles, as
// ['sfm.key: a date: "2026-07-10"', …].
function evidenceInGroup(group, keys) {
  const found = []
  for (const [k, v] of Object.entries(keys)) {
    for (const e of evidenceIn(v.help)) found.push(`${group}.${k}: ${e}`)
  }
  const sections = [...new Set(Object.values(keys).map((v) => v.section))].filter(Boolean)
  for (const s of sections) for (const e of evidenceIn(s)) found.push(`section "${s}": ${e}`)
  return found
}

describe('the evidence check', () => {
  // Each line is a piece of evidence the first paragraph of a comment once held.
  it.each([
    'Raised 0.15 → 0.3: on the 2026-07-10 building run every mis-registration was admitted.',
    'On South Building, 2 gave 60,480 vs 60,189 points.',
    'Bench (HANDOVER ▸ B-bench): +5 % on quarry.',
    'Iceland 1980 film: 7 images stranded.',
    'Read by core/features/faintRetry.js.',
    'Off: in 0.8 it cost close-range scenes cameras.',
    'plan-sfm-scale ▸ S2 at commit 7719166.',
  ])('finds it in %j', (line) => {
    expect(evidenceIn(line)).not.toEqual([])
  })

  it.each([
    'Lower it to keep more tie points from weak photos; raise it to drop more mismatches.',
    '0 = off. Values above 2 rarely help and cost time.',
    "COLMAP's default is 1.1; 2 halves the solves on a large block.",
  ])('passes help a user may read: %j', (line) => {
    expect(evidenceIn(line)).toEqual([])
  })
})
