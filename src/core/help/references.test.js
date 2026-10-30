import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { REFERENCES, citeShort, formatReference, referenceUrl, parseRefKeys } from './references.js'
import { getAllGlossaryEntries, parseGlossaryEntry } from './glossary.js'
import { methodsUsed } from './methodsUsed.js'

// Every key the app can cite: glossary `refs:` and the Quality Report's methods.
const everyMethod = methodsUsed({
  detector: 'sift',
  matcher: 'lightglue',
  verifier: 'magsac',
  sparse: true,
  georef: true,
  dense: true,
  mesh: true,
  textured: true,
  dem: true,
  demFill: 'idw',
  groundClassified: true,
  aboveGroundClassified: true,
  ortho: { blend: 'mosaic', seamline: 'graphcut', seamBlend: 'multiband', colourBalance: true },
})
const variants = ['superpoint', 'disk', 'aliked'].flatMap((detector) => methodsUsed({ detector }))
const fisheye = methodsUsed({ sparse: true, fisheye: true })
const ransac = methodsUsed({ matcher: 'bruteforce', verifier: 'ransac' })
const cited = new Set([
  ...getAllGlossaryEntries().flatMap((e) => e.refs),
  ...[...everyMethod, ...variants, ...fisheye, ...ransac].flatMap((m) => m.refs),
])

describe('references', () => {
  it('every cited key is in the bibliography', () => {
    for (const e of getAllGlossaryEntries())
      for (const k of e.refs) expect(REFERENCES[k], `${e.id} → ${k}`).toBeTruthy()
  })

  it('every bibliography entry is cited somewhere', () => {
    for (const k of Object.keys(REFERENCES)) expect(cited.has(k), k).toBe(true)
  })

  it('every entry is complete and links somewhere (DOI or URL), except a print-only source', () => {
    for (const [k, r] of Object.entries(REFERENCES)) {
      expect(r.authors.length, k).toBeGreaterThan(0)
      expect(r.year, k).toBeGreaterThan(1900)
      expect(r.title && r.venue, k).toBeTruthy()
      if (r.doi) expect(r.doi, k).toMatch(/^10\.\d{4,}\//)
      if (k !== 'brown1966') expect(referenceUrl(k), k).toMatch(/^https:\/\//)
    }
  })

  it('formats short and full citations', () => {
    expect(citeShort('lowe2004')).toBe('Lowe 2004')
    expect(citeShort('kazhdan2013')).toBe('Kazhdan & Hoppe 2013')
    expect(citeShort('bleyer2011')).toBe('Bleyer et al. 2011')
    expect(formatReference('kazhdan2013')).toBe(
      'Kazhdan, M. & Hoppe, H. (2013). Screened Poisson surface reconstruction. ACM Transactions on Graphics 32(3), 29. https://doi.org/10.1145/2487228.2487237',
    )
    expect(formatReference('lowe2004', { link: false })).toBe(
      'Lowe, D. G. (2004). Distinctive image features from scale-invariant keypoints. International Journal of Computer Vision 60(2), 91–110.',
    )
  })

  it('reads a refs: list from glossary frontmatter', () => {
    expect(parseRefKeys(' lowe2004, nister2004 ,lowe2004,')).toEqual(['lowe2004', 'nister2004'])
    const e = parseGlossaryEntry('---\nid: x\ntitle: X\nrefs: lowe2004\n---\nbody')
    expect(e.refs).toEqual(['lowe2004'])
    expect(parseGlossaryEntry('---\nid: y\ntitle: Y\n---\nbody').refs).toEqual([])
  })

  it('docs/METHODS.md lists every reference', () => {
    const md = readFileSync(new URL('../../../docs/METHODS.md', import.meta.url), 'utf8')
    const section = md.slice(md.indexOf('## 13. References'))
    for (const k of Object.keys(REFERENCES)) expect(section.includes(`- ${formatReference(k)}`), k).toBe(true)
  })
})
