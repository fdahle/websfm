import { describe, it, expect } from 'vitest'
import { buildReportHtml } from './report.js'

describe('buildReportHtml', () => {
  it('produces a self-contained document with no external assets', () => {
    const html = buildReportHtml({
      projectName: 'Antarctica-72',
      date: '2026-07-17T10:00:00Z',
      health: [
        { label: 'Registered images', value: 100, unit: '%', status: 'ok', hint: '60 / 60' },
        { label: 'GCP RMSE', value: null, unit: 'm', status: 'missing', hint: 'need ≥3 GCPs' },
      ],
      sections: [
        { title: 'Sparse', tiles: [{ label: 'Points', value: '10,000', tone: 'none' }],
          columns: [{ key: 'name', label: 'Image' }, { key: 'rms', label: 'RMS', align: 'right' }],
          rows: [{ name: 'IMG_1', rms: '0.42' }], note: 'worst first' },
      ],
    })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('Antarctica-72 — Quality Report')
    expect(html).toContain('Registered images')
    expect(html).toContain('IMG_1')
    // No external resource references.
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/src=|href=/)
  })

  it('escapes HTML in user-supplied strings', () => {
    const html = buildReportHtml({ projectName: '<img onerror=x>', health: [] })
    expect(html).not.toContain('<img onerror=x>')
    expect(html).toContain('&lt;img onerror=x&gt;')
  })

  it('tolerates an empty report', () => {
    const html = buildReportHtml({})
    expect(html).toContain('Quality Report')
  })
})
