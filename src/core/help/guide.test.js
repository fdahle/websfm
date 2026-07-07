import { describe, it, expect } from 'vitest'
import { parseGuideDoc } from './guide.js'

describe('parseGuideDoc', () => {
  const raw = [
    '---',
    'id: match-features',
    'title: Match Features',
    'summary: Finds correspondences between image pairs.',
    '---',
    'Intro prose about matching.',
    '',
    '## Ratio threshold',
    '<!-- param: ratioThreshold  default: 0.75 -->',
    "Lowe's ratio test. Lower = stricter.",
    '',
    '## Min inlier ratio',
    '<!-- param: minInlierRatio -->',
    'Reject pairs below this inlier fraction.',
  ].join('\n')

  it('parses frontmatter and intro (text before the first section)', () => {
    const doc = parseGuideDoc(raw)
    expect(doc.id).toBe('match-features')
    expect(doc.title).toBe('Match Features')
    expect(doc.summary).toBe('Finds correspondences between image pairs.')
    expect(doc.intro).toBe('Intro prose about matching.')
  })

  it('splits `## ` headings into parameter sections bound to their keys', () => {
    const doc = parseGuideDoc(raw)
    expect(doc.order).toEqual(['ratioThreshold', 'minInlierRatio'])
    const ratio = doc.params.get('ratioThreshold')
    expect(ratio.label).toBe('Ratio threshold')
    expect(ratio.defaultText).toBe('0.75')
    expect(ratio.body).toBe("Lowe's ratio test. Lower = stricter.")
  })

  it('strips the param marker from the section body', () => {
    const doc = parseGuideDoc(raw)
    expect(doc.params.get('minInlierRatio').body).not.toMatch(/param:/)
    expect(doc.params.get('minInlierRatio').defaultText).toBeNull()
  })

  it('falls back to a slug when a section has no param marker', () => {
    const doc = parseGuideDoc('---\nid: x\n---\nintro\n\n## Some Label\nbody')
    expect(doc.order).toEqual(['some-label'])
    expect(doc.params.get('some-label').label).toBe('Some Label')
  })

  it('falls back to id as title when omitted', () => {
    const doc = parseGuideDoc('---\nid: foo\n---\nbody')
    expect(doc.title).toBe('foo')
    expect(doc.summary).toBe('')
    expect(doc.order).toEqual([])
  })

  it('throws when frontmatter or id is missing', () => {
    expect(() => parseGuideDoc('no frontmatter here')).toThrow(/frontmatter/)
    expect(() => parseGuideDoc('---\ntitle: X\n---\nbody')).toThrow(/id/)
  })
})
