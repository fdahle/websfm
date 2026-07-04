import { describe, it, expect } from 'vitest'
import { parseHelpEntry, renderHelpMarkdown } from './help.js'

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

  it('tolerates a leading HTML comment before the frontmatter', () => {
    const raw = [
      '<!--',
      '  schema docs that precede the frontmatter block',
      '-->',
      '---',
      'id: focal-length',
      'title: Focal Length',
      '---',
      'body',
    ].join('\n')
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
    expect(html).toContain('class="help-link"')
    expect(html).toContain('data-help-id="bundle-adjustment"')
    expect(html).not.toContain('href="help:bundle-adjustment"')
  })

  it('leaves external links as normal anchors opening in a new tab', () => {
    const html = renderHelpMarkdown('See [docs](https://example.com).')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
  })
})
