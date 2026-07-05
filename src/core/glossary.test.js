import { describe, it, expect } from 'vitest'
import { parseHelpEntry, renderHelpMarkdown, autoLinkHtml, searchGlossary } from './glossary.js'

describe('parseHelpEntry', () => {
  it('parses frontmatter and body', () => {
    const raw = [
      '---',
      'id: focal-length',
      'title: Focal Length',
      'summary: How far the lens focuses light onto the sensor.',
      '---',
      '',
      'Body text with a [link](help:camera-intrinsics).',
    ].join('\n')

    const entry = parseHelpEntry(raw)
    expect(entry.id).toBe('focal-length')
    expect(entry.title).toBe('Focal Length')
    expect(entry.summary).toBe('How far the lens focuses light onto the sensor.')
    expect(entry.body).toBe('Body text with a [link](help:camera-intrinsics).')
  })

  it('falls back to id as title, and empty summary, when omitted', () => {
    const raw = '---\nid: foo\n---\nbody'
    const entry = parseHelpEntry(raw)
    expect(entry.title).toBe('foo')
    expect(entry.summary).toBe('')
  })

  it('collects aliases (title is always an alias)', () => {
    const raw = '---\nid: ba\ntitle: Bundle Adjustment\naliases: BA, bundle adj\n---\nbody'
    const entry = parseHelpEntry(raw)
    expect(entry.aliases).toContain('Bundle Adjustment')
    expect(entry.aliases).toContain('BA')
    expect(entry.aliases).toContain('bundle adj')
  })

  it('tolerates a leading HTML comment before the frontmatter', () => {
    const raw = ['<!--', '  schema docs', '-->', '---', 'id: focal-length', 'title: Focal Length', '---', 'body'].join('\n')
    const entry = parseHelpEntry(raw)
    expect(entry.id).toBe('focal-length')
    expect(entry.body).toBe('body')
  })

  it('throws when frontmatter is missing', () => {
    expect(() => parseHelpEntry('just a plain string')).toThrow(/missing frontmatter/)
  })

  it('throws when id is missing', () => {
    expect(() => parseHelpEntry('---\ntitle: x\n---\nbody')).toThrow(/missing id/)
  })
})

describe('renderHelpMarkdown', () => {
  it('rewrites internal help: links into data-help-id anchors', () => {
    const html = renderHelpMarkdown('See [Bundle Adjustment](help:bundle-adjustment).')
    expect(html).toContain('class="glossary-link"')
    expect(html).toContain('data-help-id="bundle-adjustment"')
    expect(html).not.toContain('href="help:bundle-adjustment"')
  })

  it('leaves external links as normal anchors opening in a new tab', () => {
    const html = renderHelpMarkdown('See [docs](https://example.com).')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
  })

  it('renders KaTeX math into markup', () => {
    const html = renderHelpMarkdown('Energy is $E = mc^2$ here.')
    expect(html).toContain('katex')
  })
})

describe('autoLinkHtml', () => {
  const index = 'bundle-adjustment'

  it('wraps the first occurrence of a known alias', () => {
    const html = autoLinkHtml('<p>We run bundle adjustment to refine poses.</p>')
    expect(html).toContain('data-help-id="bundle-adjustment"')
  })

  it('only links the first occurrence of a term', () => {
    const html = autoLinkHtml('<p>bundle adjustment then more bundle adjustment</p>')
    expect((html.match(/data-help-id="bundle-adjustment"/g) || []).length).toBe(1)
  })

  it('does not link inside anchors or code', () => {
    expect(autoLinkHtml('<a href="#">bundle adjustment</a>')).not.toContain('glossary-link')
    expect(autoLinkHtml('<code>bundle adjustment</code>')).not.toContain('glossary-link')
  })

  it('honours the no-help opt-out wrapper', () => {
    const html = autoLinkHtml('<p><span class="no-help">bundle adjustment</span></p>')
    expect(html).not.toContain('glossary-link')
  })

  it('skips the entry linking to itself', () => {
    const html = autoLinkHtml('<p>bundle adjustment</p>', index)
    expect(html).not.toContain('data-help-id="bundle-adjustment"')
  })
})

describe('searchGlossary', () => {
  it('returns all entries for an empty query', () => {
    expect(searchGlossary('').length).toBeGreaterThan(0)
  })

  it('finds an entry by title', () => {
    const ids = searchGlossary('bundle').map(e => e.id)
    expect(ids).toContain('bundle-adjustment')
  })
})
